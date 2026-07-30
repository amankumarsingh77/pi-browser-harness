/**
 * Regression tests for `createCdpBridge` connection lifecycle races.
 *
 * Covers remaining lifecycle regressions after PR #18:
 *  1. timed-out / erroring sockets must not be able to resurrect or mutate bridge
 *     state via delayed open/message events.
 *  2. callbacks from an old generation must be rejected/cleaned when that generation
 *     closes after a newer attempt has started.
 *
 * Run: npx tsx test/manual/bridge-reconnect-regression-test.ts
 */

import { EventEmitter } from "node:events";
import type { WireRequest, WireResponse } from "../../src/daemon/protocol";
import type { CdpError } from "../../src/cdp/errors";
import type { Result } from "../../src/util/result";
import { createCdpBridge } from "../../src/daemon/bridge";
import type WebSocket from "ws";

type ParsedSend = { id?: number; method?: string };

type Discover = () => Promise<Result<string, CdpError>>;

type SendResult = WireResponse;

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string): void => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (predicate: () => boolean, label: string, timeoutMs = 200): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(2);
  }
  check(false, `timed out: ${label}`);
  return false;
};

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  public readyState = FakeWebSocket.CONNECTING;
  public readonly sent: string[] = [];
  private closeDelayMs = 0;

  constructor(readonly label: string) {
    super();
  }

  setCloseDelay(ms: number): void {
    this.closeDelayMs = ms;
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    const emitClose = () => this.emit("close", code, reason);
    if (this.closeDelayMs > 0) {
      setTimeout(emitClose, this.closeDelayMs);
    } else {
      emitClose();
    }
  }

  open(): void {
    if (this.readyState === FakeWebSocket.OPEN) return;
    this.readyState = FakeWebSocket.OPEN;
    this.emit("open");
  }

  fail(error = new Error("socket error")): void {
    this.emit("error", error);
  }

  message(data: string): void {
    this.emit("message", data);
  }
}

const makeDiscover = (urls: string[]): Discover => {
  return async () => {
    const next = urls.shift();
    if (!next) {
      return {
        success: false,
        error: {
          kind: "discovery_failed",
          message: "no more URLs",
        },
      };
    }
    return { success: true, data: next };
  };
};

const requestIdByMethod = (socket: FakeWebSocket, method: string): number | null => {
  for (const payload of [...socket.sent].reverse()) {
    try {
      const parsed = JSON.parse(payload) as ParsedSend;
      if (parsed.method === method && typeof parsed.id === "number") {
        return parsed.id;
      }
    } catch {
      continue;
    }
  }
  return null;
};

// --- Test 1: constructor failure settles the attempt ---------------------

const testConstructorFailureSettlesAttempt = async (): Promise<void> => {
  let settled = false;

  const bridge = createCdpBridge({
    discoverWsUrl: async (): Promise<Result<string, CdpError>> => ({
      success: true,
      data: "ws://never-used.invalid:9",
    }),
    createWebSocket: () => {
      throw new Error("simulated constructor throw");
    },
    connectTimeoutMs: 5,
    onAttemptSettled: () => {
      settled = true;
    },
  });

  bridge.start();
  await sleep(20);
  check(settled, "constructor failure path calls settlement callback");
};

// --- Test 2: stale failure attempt cannot resurrect bridge ----------------

const testStaleFailureAttemptCannotResurrect = async (): Promise<void> => {
  const runTimeoutCase = async (): Promise<void> => {
    const sockets: FakeWebSocket[] = [];
    const responses: SendResult[] = [];
    const urls = ["ws://timedout-attempt.invalid:9222", "ws://retry-attempt.invalid:9222"];
    let settled = 0;

    const bridge = createCdpBridge({
      discoverWsUrl: makeDiscover(urls),
      createWebSocket: (url: string): WebSocket => {
        const sock = new FakeWebSocket(url);
        sockets.push(sock);
        return sock as unknown as WebSocket;
      },
      connectTimeoutMs: 15,
      onAttemptSettled: () => {
        settled += 1;
      },
    });

    bridge.start();
    await waitFor(() => sockets.length === 1, "timed out attempt socket is created");

    await waitFor(() => settled >= 1, "timed-out attempt settles");
    const first = sockets[0];

    first.open();
    await sleep(5);
    check(!bridge.isAlive(), "stale open from timed-out socket does not resurrect bridge");

    await bridge.start();
    await waitFor(() => sockets.length >= 2, "retry socket is created");
    const second = sockets[1];
    second.open();
    await waitFor(() => bridge.isAlive(), "bridge reconnects after timeout");

    await bridge.handleRequest(
      { type: "request", id: 10, method: "Runtime.enable", params: {} },
      "client-a",
      (_clientId, msg) => {
        if (msg.type === "response") {
          responses.push(msg);
        }
      },
    );

    const secondChromeId = requestIdByMethod(second, "Runtime.enable");
    check(secondChromeId !== null, "second attempt sent the request");
    if (secondChromeId === null) return;

    first.open();
    first.message(JSON.stringify({ id: secondChromeId, result: { late: true } }));
    await sleep(5);
    check(responses.length === 0, "timed-out stale socket cannot resolve live callback");

    second.message(JSON.stringify({ id: secondChromeId, result: { ok: true } }));
    await waitFor(() => responses.length === 1, "second attempt callback is resolved");
    check(responses[0]?.id === 10, "current callback resolves only from active socket");

    await bridge.stop();
  };

  const runErrorCase = async (): Promise<void> => {
    const sockets: FakeWebSocket[] = [];
    const responses: SendResult[] = [];
    const urls = ["ws://errored-attempt.invalid:9222", "ws://retry-after-error.invalid:9222"];

    const bridge = createCdpBridge({
      discoverWsUrl: makeDiscover(urls),
      createWebSocket: (url: string): WebSocket => {
        const sock = new FakeWebSocket(url);
        sockets.push(sock);
        return sock as unknown as WebSocket;
      },
      connectTimeoutMs: 20,
    });

    await bridge.start();
    await waitFor(() => sockets.length === 1, "initial attempt socket is created");
    const first = sockets[0];
    first.open();
    first.setCloseDelay(15);

    await bridge.handleRequest(
      { type: "request", id: 11, method: "Runtime.enable", params: {} },
      "client-b",
      (_clientId, msg) => {
        if (msg.type === "response") {
          responses.push(msg);
        }
      },
    );

    first.fail(new Error("forced failure"));
    await bridge.start();
    await waitFor(() => sockets.length >= 2, "retry socket is created after error");

    const second = sockets[1];
    second.open();
    await waitFor(() => bridge.isAlive(), "bridge reconnects after error");

    await bridge.handleRequest(
      { type: "request", id: 12, method: "Runtime.disable", params: {} },
      "client-b",
      (_clientId, msg) => {
        if (msg.type === "response") {
          responses.push(msg);
        }
      },
    );

    const secondChromeId = requestIdByMethod(second, "Runtime.disable");
    check(secondChromeId !== null, "second attempt sent the request");
    if (secondChromeId === null) return;

    first.open();
    first.message(JSON.stringify({ id: secondChromeId, result: { late: true } }));
    await sleep(5);
    check(!responses.some((msg) => msg.id === 12), "stale message from errored socket does not resolve current callback");

    second.message(JSON.stringify({ id: secondChromeId, result: { ok: true } }));
    await waitFor(() => responses.some((msg) => msg.id === 12), "current callback resolves after retry response");
    check(
      responses.some((msg) => msg.id === 12 && (typeof msg.result === "object" || typeof msg.result === "string" || msg.result === null)),
      "current callback resolves after stale-socket error sequence",
    );

    await bridge.stop();
  };

  await runTimeoutCase();
  await runErrorCase();
  check(true, "timed-out and errored sockets do not resurrect or mutate bridge");
};

// --- Test 3: old-generation close only affects old callbacks ------------

const testOldGenerationCloseDoesNotAffectNewCallbacks = async (): Promise<void> => {
  const sockets: FakeWebSocket[] = [];
  const responses: SendResult[] = [];
  const urls = ["ws://old-gen.invalid:9222", "ws://new-gen.invalid:9222"];

  const bridge = createCdpBridge({
    discoverWsUrl: makeDiscover(urls),
    createWebSocket: (url: string): WebSocket => {
      const sock = new FakeWebSocket(url);
      sockets.push(sock);
      return sock as unknown as WebSocket;
    },
    connectTimeoutMs: 50,
  });

  await bridge.start();
  await waitFor(() => sockets.length === 1, "old-generation socket is created");
  const first = sockets[0];
  first.open();

  first.setCloseDelay(25);

  const oldRequest: WireRequest = { type: "request", id: 31, method: "Target.getTargets", params: {} };
  await bridge.handleRequest(oldRequest, "client-c", (_clientId, msg) => {
    if (msg.type === "response") {
      responses.push(msg);
    }
  });
  const oldDaemonId = requestIdByMethod(first, "Target.getTargets");
  check(oldDaemonId !== null, "old-generation request is in-flight");

  first.close();
  await bridge.start();
  await waitFor(() => sockets.length === 2, "new generation socket is created");

  const second = sockets[1];
  second.open();
  await waitFor(() => bridge.isAlive(), "bridge stays alive on new generation");

  const newRequest: WireRequest = { type: "request", id: 32, method: "Runtime.getProperties", params: {} };
  await bridge.handleRequest(newRequest, "client-c", (_clientId, msg) => {
    if (msg.type === "response") {
      responses.push(msg);
    }
  });

  const newDaemonId = requestIdByMethod(second, "Runtime.getProperties");
  check(newDaemonId !== null, "new-generation request is sent");
  if (newDaemonId === null) return;

  check(
    !responses.some((msg) => msg.id === 31),
    "old generation callback is not resolved before delayed close",
  );

  second.message(JSON.stringify({ id: newDaemonId, result: { ok: true } }));
  await waitFor(() => responses.some((msg) => msg.id === 32), "new-generation callback resolves");

  await waitFor(
    () => responses.some((msg) => msg.id === 31 && msg.error?.message === "Chrome disconnected"),
    "old-generation close rejects old callbacks",
    80,
  );

  check(
    responses.some((msg) => msg.id === 31 && msg.error?.message === "Chrome disconnected"),
    "old-generation callback receives Chrome-disconnected error",
  );
  check(
    !responses.some((msg) => msg.id === 32 && typeof msg.error !== "undefined"),
    "new-generation callback is unaffected by old-generation close",
  );

  await bridge.stop();
};

async function main(): Promise<void> {
  console.log("bridge connection regression tests\n");

  await testConstructorFailureSettlesAttempt();
  await testStaleFailureAttemptCannotResurrect();
  await testOldGenerationCloseDoesNotAffectNewCallbacks();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("bridge regression test failed:", err);
  process.exit(1);
});
