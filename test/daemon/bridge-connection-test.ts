/**
 * Regression tests for `createCdpBridge` connection lifecycle races.
 *
 * Covers remaining lifecycle regressions after PR #18:
 *  1. discovery must be bounded by `connectTimeoutMs`
 *  2. handleRequest should stop waiting as soon as the active attempt settles
 *  3. stop() and a dropped connection must resolve pending callbacks
 *  4. constructor and stale-generation cleanup still must reject old callbacks
 */

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import type { WireRequest, WireResponse } from "../../src/daemon/protocol";
import type { CdpError } from "../../src/cdp/errors";
import type { Result } from "../../src/util/result";
import { createCdpBridge } from "../../src/daemon/bridge";
import type WebSocket from "ws";

type ParsedSend = { id?: number; method?: string };
type Discover = () => Promise<Result<string, CdpError>>;
type SendResult = WireResponse;

const check = (cond: boolean, label: string): void => {
  assert.ok(cond, label);
};

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const waitFor = async (
  predicate: () => boolean,
  _label: string,
  timeoutMs = 120,
  intervalMs = 2,
): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(intervalMs);
  }
  return false;
};

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  public readyState = FakeWebSocket.CONNECTING;
  public readonly sent: string[] = [];
  private readonly closeDelayMs: number;

  constructor(readonly label: string, options: { closeDelayMs?: number } = {}) {
    super();
    this.closeDelayMs = options.closeDelayMs ?? 0;
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;

    const closeNow = (): void => {
      if (this.readyState === FakeWebSocket.CLOSED) return;
      this.readyState = FakeWebSocket.CLOSED;
      this.emit("close", code, reason);
    };

    if (this.closeDelayMs > 0) {
      this.readyState = FakeWebSocket.CLOSING;
      setTimeout(closeNow, this.closeDelayMs);
      return;
    }

    closeNow();
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

const withSocket = (
  sockets: FakeWebSocket[],
  index: number,
  label: string,
): FakeWebSocket | null => {
  const socket = sockets[index] ?? null;
  if (!socket) {
    check(false, label);
    return null;
  }
  return socket;
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

  await bridge.start();
  check(await waitFor(() => settled, "constructor failure path calls settlement callback", 50), "constructor failure path calls settlement callback");
};

// --- Test 2: bounded discovery is required for unresolved discoverWsUrl ----

const testUnresolvedDiscoveryIsBounded = async (): Promise<void> => {
  let settled = 0;
  let discoverCalls = 0;
  const sockets: FakeWebSocket[] = [];
  const bridge = createCdpBridge({
    discoverWsUrl: async () => {
      discoverCalls += 1;
      if (discoverCalls === 1) {
        return new Promise(() => undefined);
      }
      return { success: true, data: "ws://retry-attempt.invalid:9222" };
    },
    createWebSocket: (url: string): WebSocket => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    connectTimeoutMs: 25,
    onAttemptSettled: () => {
      settled += 1;
    },
  });

  await bridge.start();
  check(await waitFor(() => settled === 1, "unresolved discovery settles by timeout", 100), "unresolved discovery is bounded by timeout");
  check(sockets.length === 0, "timed-out discovery attempt does not create a socket");
  check(discoverCalls === 1, "only one discover call happened before timeout");

  await bridge.start();
  check(
    await waitFor(() => discoverCalls >= 2 && sockets.length > 0, "retry discovery creates a fresh socket after timeout", 150),
    "retry discovery runs after bounded first attempt",
  );
  const retrySocket = withSocket(sockets, 0, "retry socket exists after bounded discovery timeout");
  if (!retrySocket) {
    await bridge.stop();
    return;
  }

  retrySocket.open();
  check(await waitFor(() => bridge.isAlive(), "bridge reconnects after bounded timeout"), "bridge recovers after bounded discovery timeout");
  await bridge.stop();
};

// --- Test 3: failed attempt should short-circuit handleRequest wait -------

const testHandleRequestStopsPollingAfterFailedAttempt = async (): Promise<void> => {
  const responses: SendResult[] = [];
  const sockets: FakeWebSocket[] = [];
  const bridge = createCdpBridge({
    discoverWsUrl: async (): Promise<Result<string, CdpError>> => ({
      success: true,
      data: "ws://fast-fail.invalid:9222",
    }),
    createWebSocket: (url: string): WebSocket => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      setTimeout(() => socket.fail(new Error("forced connect failure")), 0);
      return socket as unknown as WebSocket;
    },
    connectTimeoutMs: 30,
  });

  await bridge.start();
  check(await waitFor(() => sockets.length === 1, "connect attempt creates socket", 50), "handleRequest fast-fail path creates a socket");

  const start = Date.now();
  await bridge.handleRequest(
    { type: "request", id: 20, method: "Runtime.enable", params: {} },
    "client-fast",
    (_clientId, msg) => {
      if (msg.type === "response") {
        responses.push(msg);
      }
    },
  );
  const elapsed = Date.now() - start;

  check(elapsed < 200, "handleRequest returns quickly after failed attempt settlement");
  check(
    responses.some((msg) => msg.id === 20 && msg.error?.message === "Chrome not connected"),
    "handleRequest fails fast with Chrome not connected",
  );
  await bridge.stop();
};

// --- Test 4: stop() must settle pending callbacks -----------------------

const testStopRejectsPendingRequestCallbacks = async (): Promise<void> => {
  const responses: SendResult[] = [];
  const sockets: FakeWebSocket[] = [];
  const bridge = createCdpBridge({
    discoverWsUrl: async (): Promise<Result<string, CdpError>> => ({
      success: true,
      data: "ws://stop-callback.invalid:9222",
    }),
    createWebSocket: (url: string): WebSocket => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });

  await bridge.start();
  const initial = await waitFor(() => sockets.length === 1, "socket created for stop test", 50);
  check(initial, "socket created for stop test");
  if (!initial) {
    await bridge.stop();
    return;
  }

  const socket = sockets[0];
  if (!socket) {
    await bridge.stop();
    return;
  }

  socket.open();
  const req: WireRequest = { type: "request", id: 40, method: "Runtime.enable", params: {} };
  await bridge.handleRequest(req, "client-stop", (_clientId, msg) => {
    if (msg.type === "response") {
      responses.push(msg);
    }
  });

  const sentDaemonId = requestIdByMethod(socket, "Runtime.enable");
  check(sentDaemonId !== null, "stop test request is sent");

  await bridge.stop();
  check(
    await waitFor(
      () => responses.some((msg) => msg.id === 40 && msg.error?.message === "Chrome disconnected"),
      "stop settles pending callback with Chrome disconnected",
      80,
    ),
    "stop sends Chrome-disconnected response for pending callback",
  );
};

// --- Test 5: an established connection dropping rejects its in-flight requests ---

const testDropRejectsInFlightRequests = async (): Promise<void> => {
  const sockets: FakeWebSocket[] = [];
  const responses: SendResult[] = [];

  const bridge = createCdpBridge({
    connectTimeoutMs: 60,
    discoverWsUrl: async (): Promise<Result<string, CdpError>> => ({
      success: true,
      data: "ws://drop-inflight.invalid:9222",
    }),
    createWebSocket: (url: string): WebSocket => {
      const socket = new FakeWebSocket(url);
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
  });

  await bridge.start();
  check(await waitFor(() => sockets.length === 1, "drop test socket created", 50), "drop test socket created");
  const socket = withSocket(sockets, 0, "drop test socket exists");
  if (!socket) {
    await bridge.stop();
    return;
  }

  socket.open();
  const req: WireRequest = { type: "request", id: 41, method: "Runtime.enable", params: {} };
  await bridge.handleRequest(req, "client-drop", (_clientId, msg) => {
    if (msg.type === "response") {
      responses.push(msg);
    }
  });
  check(requestIdByMethod(socket, "Runtime.enable") !== null, "drop test request is in flight");
  check(responses.length === 0, "drop test request has no response yet");

  // The attempt already settled when the socket opened, so the close path must reject
  // its callbacks itself rather than leaving them to the 10s command timeout.
  socket.close();
  check(
    await waitFor(
      () => responses.some((msg) => msg.id === 41 && msg.error?.message === "Chrome disconnected"),
      "in-flight request rejected on drop",
      120,
    ),
    "a dropped connection rejects its in-flight requests immediately",
  );

  await bridge.stop();
};

// --- Test 6: stale failure attempt cannot resurrect bridge ----------------

const testStaleFailureAttemptCannotResurrect = async (): Promise<void> => {
  const runStaleClosedSocketCase = async (): Promise<void> => {
    const sockets: FakeWebSocket[] = [];
    const responses: SendResult[] = [];
    const urls = ["ws://timedout-attempt.invalid:9222", "ws://retry-attempt.invalid:9222"];
    let settled = 0;

    const bridge = createCdpBridge({
      discoverWsUrl: makeDiscover(urls),
      createWebSocket: (url: string): WebSocket => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      connectTimeoutMs: 15,
      onAttemptSettled: () => {
        settled += 1;
      },
    });

    await bridge.start();
    check(await waitFor(() => sockets.length >= 1, "stale closed socket attempt creates first socket", 50), "stale closed socket attempt creates first socket");
    const first = withSocket(sockets, 0, "first stale socket exists");
    if (!first) {
      await bridge.stop();
      return;
    }

    first.open();
    first.close();
    check(await waitFor(() => settled >= 1, "stale closed socket attempt settles", 80), "stale closed socket attempt settles");
    check(!bridge.isAlive(), "stale closed socket does not resurrect bridge");

    await bridge.start();
    check(await waitFor(() => sockets.length >= 2, "retry socket is created after stale close", 80), "retry socket is created after stale close");
    const second = withSocket(sockets, 1, "second socket exists after retry");
    if (!second) {
      await bridge.stop();
      return;
    }

    second.open();
    check(await waitFor(() => bridge.isAlive(), "bridge reconnects after stale close", 80), "bridge reconnects after stale close");

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
    if (secondChromeId === null) {
      await bridge.stop();
      return;
    }

    first.message(JSON.stringify({ id: secondChromeId, result: { late: true } }));
    check(!responses.some((msg) => msg.id === 10), "stale closed socket cannot resolve live callback");

    second.message(JSON.stringify({ id: secondChromeId, result: { ok: true } }));
    check(
      await waitFor(() => responses.some((msg) => msg.id === 10), "second attempt callback is resolved", 60),
      "current callback resolves from active socket",
    );

    await bridge.stop();
  };

  const runErrorCase = async (): Promise<void> => {
    const sockets: FakeWebSocket[] = [];
    const responses: SendResult[] = [];
    const urls = ["ws://errored-attempt.invalid:9222", "ws://retry-after-error.invalid:9222"];

    const bridge = createCdpBridge({
      discoverWsUrl: makeDiscover(urls),
      createWebSocket: (url: string): WebSocket => {
        const socket = new FakeWebSocket(url);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      connectTimeoutMs: 20,
    });

    await bridge.start();
    check(await waitFor(() => sockets.length === 1, "initial attempt socket is created", 50), "error test creates first socket");
    const first = withSocket(sockets, 0, "initial socket exists after error");
    if (!first) {
      await bridge.stop();
      return;
    }

    first.open();

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
    first.close();

    await bridge.start();
    check(
      await waitFor(() => sockets.length >= 2, "retry socket is created after error", 100),
      "retry socket is created after error",
    );
    const second = withSocket(sockets, 1, "retry socket exists after error");
    if (!second) {
      await bridge.stop();
      return;
    }

    second.open();
    check(await waitFor(() => bridge.isAlive(), "bridge reconnects after error", 80), "bridge reconnects after error");

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
    if (secondChromeId === null) {
      await bridge.stop();
      return;
    }

    first.message(JSON.stringify({ id: secondChromeId, result: { late: true } }));
    check(!responses.some((msg) => msg.id === 12), "stale message from errored socket does not resolve current callback");

    second.message(JSON.stringify({ id: secondChromeId, result: { ok: true } }));
    check(
      await waitFor(() => responses.some((msg) => msg.id === 12), "current callback resolves after retry response", 80),
      "current callback resolves after retry response",
    );

    await bridge.stop();
  };

  await runStaleClosedSocketCase();
  await runErrorCase();
};

// --- Test 7: old-generation close should not affect newer callback ----------

const testOldGenerationCloseDoesNotAffectNewCallbacks = async (): Promise<void> => {
  const sockets: FakeWebSocket[] = [];
  const responses: SendResult[] = [];
  const urls = ["ws://old-gen.invalid:9222", "ws://new-gen.invalid:9222"];

  const bridge = createCdpBridge({
    discoverWsUrl: makeDiscover(urls),
    createWebSocket: (url: string): WebSocket => {
      const delayCloseMs = sockets.length === 0 ? 12 : 0;
      const socket = new FakeWebSocket(url, { closeDelayMs: delayCloseMs });
      sockets.push(socket);
      return socket as unknown as WebSocket;
    },
    connectTimeoutMs: 50,
  });

  await bridge.start();
  check(await waitFor(() => sockets.length === 1, "old-generation socket is created", 50), "old generation socket exists");
  const first = withSocket(sockets, 0, "old generation socket exists");
  if (!first) {
    await bridge.stop();
    return;
  }

  first.open();

  const oldRequest: WireRequest = { type: "request", id: 31, method: "Target.getTargets", params: {} };
  await bridge.handleRequest(oldRequest, "client-c", (_clientId, msg) => {
    if (msg.type === "response") {
      responses.push(msg);
    }
  });

  const oldChromeId = requestIdByMethod(first, "Target.getTargets");
  check(oldChromeId !== null, "old-generation request is in-flight");
  if (!oldChromeId) {
    await bridge.stop();
    return;
  }

  first.close();

  await bridge.start();
  check(await waitFor(() => sockets.length >= 2, "new generation socket is created", 80), "new generation socket exists");
  const second = withSocket(sockets, 1, "new generation socket exists");
  if (!second) {
    await bridge.stop();
    return;
  }

  second.open();
  check(await waitFor(() => bridge.isAlive(), "bridge stays alive on new generation", 80), "bridge stays alive on new generation");

  const newRequest: WireRequest = { type: "request", id: 32, method: "Runtime.getProperties", params: {} };
  await bridge.handleRequest(newRequest, "client-c", (_clientId, msg) => {
    if (msg.type === "response") {
      responses.push(msg);
    }
  });

  const newChromeId = requestIdByMethod(second, "Runtime.getProperties");
  check(newChromeId !== null, "new-generation request is sent");
  if (!newChromeId) {
    await bridge.stop();
    return;
  }

  check(!responses.some((msg) => msg.id === 31), "old generation callback is pending before close");

  second.message(JSON.stringify({ id: newChromeId, result: { ok: true } }));
  check(
    await waitFor(() => responses.some((msg) => msg.id === 32), "new generation callback resolves", 80),
    "new-generation callback resolves",
  );

  check(
    await waitFor(
      () => responses.some((msg) => msg.id === 31 && msg.error?.message === "Chrome disconnected"),
      "old-generation close rejects old callbacks",
      80,
    ),
    "old-generation callback receives Chrome-disconnected error",
  );

  check(
    !responses.some((msg) => msg.id === 32 && msg.error !== undefined),
    "new-generation callback is unaffected by old-generation close",
  );

  await bridge.stop();
};

describe("cdp bridge connection lifecycle", () => {
  test("a WebSocket constructor failure settles the attempt", testConstructorFailureSettlesAttempt);
  test("an unresolved discovery is bounded by the connect timeout", testUnresolvedDiscoveryIsBounded);
  test("handleRequest stops waiting once the attempt fails", testHandleRequestStopsPollingAfterFailedAttempt);
  test("stop() rejects pending request callbacks", testStopRejectsPendingRequestCallbacks);
  test("a dropped connection rejects its in-flight requests", testDropRejectsInFlightRequests);
  test("a stale failed attempt cannot resurrect the bridge", testStaleFailureAttemptCannotResurrect);
  test("an old-generation close leaves new-generation callbacks alone", testOldGenerationCloseDoesNotAffectNewCallbacks);
});
