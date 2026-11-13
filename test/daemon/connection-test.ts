// One dial is one "Allow remote debugging" prompt in Chrome. These tests pin the rules that keep
// the prompt count at one after a sleep/resume: a dial outlives the caller wait, callers join the
// dial in flight, outright failures back off, and a dropped connection may re-dial once at once.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import { setTimeout as sleep } from "node:timers/promises";
import type { CdpError } from "../../src/cdp/errors";
import { type Result, err, ok } from "../../src/util/result";
import { type ChromeSocket, type ConnectionEndReason, createChromeConnection } from "../../src/daemon/connection";
import { createCdpBridge, describeDisconnected } from "../../src/daemon/bridge";
import { DAEMON_RECONNECT_METHOD, type WireResponse } from "../../src/daemon/protocol";

class FakeSocket extends EventEmitter implements ChromeSocket {
  public readyState = 0;
  public readonly sent: string[] = [];
  send(payload: string): void { this.sent.push(payload); }
  close(): void {
    if (this.readyState === 3) return;
    this.readyState = 3;
    this.emit("close");
  }
  // The WebSocket handshake alone: Chrome has accepted the transport but answered nothing.
  openTransport(): void { this.readyState = 1; this.emit("open"); }
  message(frame: unknown): void { this.emit("message", JSON.stringify(frame)); }
  // A browser that is serving CDP: the transport opens and the readiness command is acknowledged.
  open(): void { this.openTransport(); this.message({ id: 0, result: {} }); }
  fail(message: string): void { this.emit("error", new Error(message)); this.close(); }
  drop(): void { this.close(); }
}

type Harness = {
  readonly sockets: FakeSocket[];
  readonly ends: ConnectionEndReason[];
  readonly messages: string[];
  readonly discoverCalls: () => number;
  readonly connection: ReturnType<typeof createChromeConnection>;
};

const harness = (opts: {
  readonly connectTimeoutMs?: number;
  readonly attemptLifetimeMs?: number;
  readonly cooldownMs?: number;
  readonly cooldownMaxMs?: number;
  readonly discover?: () => Promise<Result<string, CdpError>>;
} = {}): Harness => {
  const sockets: FakeSocket[] = [];
  const ends: ConnectionEndReason[] = [];
  const messages: string[] = [];
  let discoverCalls = 0;
  const connection = createChromeConnection(
    {
      discoverWsUrl: () => { discoverCalls += 1; return (opts.discover ?? (() => Promise.resolve(ok("ws://fake"))))(); },
      createWebSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
      connectTimeoutMs: opts.connectTimeoutMs ?? 20,
      attemptLifetimeMs: opts.attemptLifetimeMs ?? 200,
      cooldownMs: opts.cooldownMs ?? 60,
      cooldownMaxMs: opts.cooldownMaxMs ?? 1_000,
    },
    { onMessage: (raw) => { messages.push(raw); }, onEnd: (_g, reason) => { ends.push(reason); } },
  );
  return { sockets, ends, messages, discoverCalls: () => discoverCalls, connection };
};

describe("chrome connection: one dial, one prompt", () => {
  test("a dial outlives the caller wait and later callers join it instead of dialing again", async () => {
    const h = harness({ connectTimeoutMs: 20, attemptLifetimeMs: 500 });
    const first = await h.connection.connect();
    assert.equal(first, false, "the caller gives up waiting");
    assert.equal(h.sockets.length, 1);
    assert.notEqual(h.sockets[0]?.readyState, 3, "the dial is still open");
    assert.equal(h.connection.status().state, "connecting");

    const second = h.connection.connect();
    const third = h.connection.connect();
    await sleep(5);
    assert.equal(h.sockets.length, 1, "no second socket, hence no second prompt");

    h.sockets[0]?.open();
    assert.deepEqual(await Promise.all([second, third]), [true, true]);
    assert.equal(h.connection.isOpen(), true);
    assert.equal(h.connection.status().state, "open");
    h.connection.stop();
  });

  test("an unanswered dial is abandoned after its lifetime and a cooldown starts", async () => {
    const h = harness({ connectTimeoutMs: 10, attemptLifetimeMs: 40, cooldownMs: 60 });
    assert.equal(await h.connection.connect(), false);
    await sleep(60);
    assert.deepEqual(h.ends, ["failed"]);
    assert.equal(h.sockets[0]?.readyState, 3, "the abandoned socket is closed");
    const status = h.connection.status();
    assert.equal(status.state, "cooldown");
    assert.match(status.lastFailure, /Allow remote debugging/);
    assert.ok(status.retryInMs > 0 && status.retryInMs <= 60);
    assert.equal(await h.connection.connect(), false, "cooldown: answered without dialing");
    assert.equal(h.sockets.length, 1, "no new socket during cooldown");
    h.connection.stop();
  });

  test("consecutive failures double the cooldown up to the cap, and success resets it", async () => {
    let attempt = 0;
    const h = harness({
      connectTimeoutMs: 10,
      attemptLifetimeMs: 500,
      cooldownMs: 20,
      cooldownMaxMs: 50,
      discover: () => { attempt += 1; return Promise.resolve(err({ kind: "discovery_failed", message: `down ${attempt}` })); },
    });
    const retryIn = (): number => { const s = h.connection.status(); return s.state === "cooldown" ? s.retryInMs : -1; };

    await h.connection.connect();
    const first = retryIn();
    assert.ok(first > 0 && first <= 20, `first cooldown ${first}`);
    await sleep(25);
    await h.connection.connect();
    const second = retryIn();
    assert.ok(second > 20 && second <= 40, `second cooldown ${second}`);
    await sleep(45);
    await h.connection.connect();
    const third = retryIn();
    assert.ok(third > 40 && third <= 50, `capped cooldown ${third}`);
    assert.equal(h.discoverCalls(), 3);

    // A cooldown is skipped by reconnectNow, and a successful open resets the backoff.
    assert.equal(h.connection.status().state, "cooldown");
    const ok1 = harness({ connectTimeoutMs: 10, attemptLifetimeMs: 500, cooldownMs: 20, cooldownMaxMs: 50 });
    const open = ok1.connection.connect();
    await sleep(2);
    ok1.sockets[0]?.open();
    assert.equal(await open, true);
    ok1.sockets[0]?.drop();
    assert.deepEqual(ok1.ends, ["dropped"]);
    assert.equal(ok1.connection.status().state, "disconnected", "a drop carries no cooldown");
    ok1.connection.stop();
    h.connection.stop();
  });

  test("reconnectNow dials during a cooldown; a plain connect does not", async () => {
    const h = harness({ connectTimeoutMs: 10, attemptLifetimeMs: 500, cooldownMs: 10_000 });
    h.sockets.length = 0;
    const pending = h.connection.connect();
    await sleep(2);
    h.sockets[0]?.fail("denied");
    assert.equal(await pending, false);
    assert.equal(h.connection.status().state, "cooldown");
    assert.equal(await h.connection.connect(), false);
    assert.equal(h.sockets.length, 1);

    const forced = h.connection.reconnectNow();
    await sleep(2);
    assert.equal(h.sockets.length, 2, "reconnectNow opened a fresh dial");
    h.sockets[1]?.open();
    assert.equal(await forced, true);
    h.connection.stop();
  });

  test("a dropped connection re-dials at once on the next demand (the one legitimate prompt after resume)", async () => {
    const h = harness({ connectTimeoutMs: 10, attemptLifetimeMs: 500, cooldownMs: 10_000 });
    const open = h.connection.connect();
    await sleep(2);
    h.sockets[0]?.open();
    assert.equal(await open, true);
    h.sockets[0]?.drop();
    const redial = h.connection.connect();
    await sleep(2);
    assert.equal(h.sockets.length, 2, "re-dial after a drop is not throttled");
    h.sockets[1]?.open();
    assert.equal(await redial, true);
    h.connection.stop();
  });
});

describe("chrome connection: ready means Chrome answered", () => {
  test("an open WebSocket with no CDP reply is still connecting, not open", async () => {
    const h = harness({ connectTimeoutMs: 20, attemptLifetimeMs: 500 });
    const starting = h.connection.start();
    await sleep(1);
    h.sockets[0]?.openTransport();
    assert.equal(await starting, false, "the caller is told the connection is not ready");
    assert.equal(h.connection.isOpen(), false);
    assert.equal(h.connection.status().state, "connecting");
    assert.deepEqual(h.sockets[0]?.sent.map((p) => JSON.parse(p) as unknown), [
      { id: 0, method: "Target.setDiscoverTargets", params: { discover: true } },
    ]);
    assert.equal(h.connection.send("{}").success, false, "nothing may be sent on a connection that is not ready");
    h.connection.stop();
  });

  test("a late reply completes the same attempt without another dial", async () => {
    const h = harness({ connectTimeoutMs: 15, attemptLifetimeMs: 500 });
    const starting = h.connection.start();
    await sleep(1);
    h.sockets[0]?.openTransport();
    assert.equal(await starting, false);

    const joined = h.connection.connect();
    h.sockets[0]?.message({ id: 0, result: {} });
    assert.equal(await joined, true);
    assert.equal(h.connection.isOpen(), true);
    assert.equal(h.connection.status().state, "open");
    assert.equal(h.sockets.length, 1, "no second WebSocket, so no second Allow prompt");
    assert.equal(h.discoverCalls(), 1);
    h.connection.stop();
  });

  test("a browser that never answers is abandoned after the attempt lifetime, with a cooldown", async () => {
    const h = harness({ connectTimeoutMs: 10, attemptLifetimeMs: 50, cooldownMs: 200 });
    const starting = h.connection.start();
    await sleep(1);
    h.sockets[0]?.openTransport();
    assert.equal(await starting, false);
    await sleep(70);
    assert.deepEqual(h.ends, ["failed"]);
    assert.equal(h.sockets[0]?.readyState, 3, "the unanswered socket is closed");
    const status = h.connection.status();
    assert.equal(status.state, "cooldown");
    assert.match(status.lastFailure, /no answer from Chrome/);
    assert.equal(await h.connection.connect(), false);
    assert.equal(h.sockets.length, 1, "no automatic re-dial during the cooldown");
  });

  test("Chrome rejecting the first command fails the attempt with its reason", async () => {
    const h = harness({ connectTimeoutMs: 50 });
    const starting = h.connection.start();
    await sleep(1);
    h.sockets[0]?.openTransport();
    h.sockets[0]?.message({ id: 0, error: { code: -32000, message: "Not allowed" } });
    assert.equal(await starting, false);
    assert.deepEqual(h.ends, ["failed"]);
    const status = h.connection.status();
    assert.match(status.state === "cooldown" ? status.lastFailure : "", /Chrome refused the first command: Not allowed/);
  });

  test("the socket closing before Chrome answers is a failed attempt, not a dropped connection", async () => {
    const h = harness({ connectTimeoutMs: 50 });
    const starting = h.connection.start();
    await sleep(1);
    h.sockets[0]?.openTransport();
    h.sockets[0]?.drop();
    assert.equal(await starting, false);
    assert.deepEqual(h.ends, ["failed"]);
  });

  test("events Chrome sends ahead of its answer are delivered after it, in order", async () => {
    const h = harness({ connectTimeoutMs: 50 });
    const starting = h.connection.start();
    await sleep(1);
    const socket = h.sockets[0];
    socket?.openTransport();
    socket?.message({ method: "Target.targetCreated", params: { n: 1 } });
    socket?.message({ method: "Target.targetCreated", params: { n: 2 } });
    assert.deepEqual(h.messages, [], "nothing is delivered before Chrome answers");
    socket?.message({ id: 0, result: {} });
    assert.equal(await starting, true);
    socket?.message({ method: "Target.targetCreated", params: { n: 3 } });
    assert.deepEqual(
      h.messages.map((m) => JSON.parse(m) as unknown),
      [1, 2, 3].map((n) => ({ method: "Target.targetCreated", params: { n } })),
    );
    h.connection.stop();
  });
});

describe("bridge messages while disconnected", () => {
  const request = (bridge: ReturnType<typeof createCdpBridge>, id: number, method: string): Promise<WireResponse | undefined> =>
    new Promise((resolve) => {
      let answered: WireResponse | undefined;
      void bridge.handleRequest({ type: "request", id, method, params: {} }, "c1", (_cid, msg) => {
        if (msg.type === "response") answered = msg;
      }).then(() => { resolve(answered); });
    });

  test("a pending dial is reported as waiting for the Allow prompt, and Daemon.reconnect is answered by the daemon", async () => {
    const sockets: FakeSocket[] = [];
    const bridge = createCdpBridge({
      discoverWsUrl: () => Promise.resolve(ok("ws://fake")),
      createWebSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
      connectTimeoutMs: 10,
      attemptLifetimeMs: 500,
    });
    const r1 = await request(bridge, 1, "Runtime.enable");
    assert.match(String(r1?.error?.message), /^Chrome not connected: a connection attempt has been waiting \d+s/);
    assert.match(String(r1?.error?.message), /Allow remote debugging/);
    assert.equal(sockets.length, 1);

    const r2 = await request(bridge, 2, "Runtime.enable");
    assert.equal(sockets.length, 1, "the second request joined the pending dial");
    assert.match(String(r2?.error?.message), /^Chrome not connected: a connection attempt has been waiting/);

    const reconnect = request(bridge, 3, DAEMON_RECONNECT_METHOD);
    await sleep(2);
    sockets.at(-1)?.open();
    const r3 = await reconnect;
    assert.deepEqual(r3?.result, { connected: true });
    assert.equal(bridge.isAlive(), true);
    await bridge.stop();
  });

  test("a request while Chrome has not answered yet is told to wait, and is never sent to Chrome", async () => {
    const sockets: FakeSocket[] = [];
    const bridge = createCdpBridge({
      discoverWsUrl: () => Promise.resolve(ok("ws://fake")),
      createWebSocket: () => { const s = new FakeSocket(); sockets.push(s); return s; },
      connectTimeoutMs: 20,
      attemptLifetimeMs: 500,
    });
    await bridge.start();
    await sleep(1);
    const socket = sockets[0];
    assert.ok(socket, "the daemon dialed Chrome");
    socket.openTransport();

    const r1 = await request(bridge, 1, "Page.navigate");
    assert.match(String(r1?.error?.message), /^Chrome not connected: a connection attempt has been waiting \d+s/);
    assert.doesNotMatch(String(r1?.error?.message), /Timeout after/);
    assert.equal(bridge.isAlive(), false);
    assert.equal(socket.sent.length, 1, "only the readiness command reached Chrome");

    socket.message({ id: 0, result: {} });
    assert.equal(bridge.isAlive(), true);
    void bridge.handleRequest({ type: "request", id: 2, method: "Page.navigate", params: {} }, "c1", () => undefined);
    await sleep(1);
    assert.equal(socket.sent.length, 2, "once Chrome answers, requests go through on the same socket");
    assert.equal(sockets.length, 1);
    await bridge.stop();
  });

  test("describeDisconnected names the next automatic attempt during a cooldown", () => {
    assert.equal(
      describeDisconnected({ state: "cooldown", retryInMs: 29_400, lastFailure: "no chrome" }),
      "Chrome not connected: the last attempt failed (no chrome). The next automatic attempt is in 30s; run /browser-setup to retry now.",
    );
    assert.equal(describeDisconnected({ state: "disconnected", lastFailure: null }), "Chrome not connected");
  });
});
