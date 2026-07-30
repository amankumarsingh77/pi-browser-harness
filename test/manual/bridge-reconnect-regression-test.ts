/**
 * Regression tests for `createCdpBridge` connection lifecycle races.
 *
 * Covers two still-open CodeRabbit findings:
 *  1. A synchronous `new WebSocket(...)` constructor failure must settle the
 *     current connection attempt.
 *  2. Stale socket handlers from older attempts must not mutate shared bridge
 *     state after a newer attempt has started.
 *
 * Run: npx tsx test/manual/bridge-reconnect-regression-test.ts
 */

import { EventEmitter } from "node:events";
import { createCdpBridge } from "../../src/daemon/bridge";
import type { Result } from "../../src/util/result";
import type { CdpError } from "../../src/cdp/errors";
import type WebSocket from "ws";

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

class FakeWebSocket extends EventEmitter {
  static CONNECTING = 0;
  static OPEN = 1;
  static CLOSING = 2;
  static CLOSED = 3;

  public readyState = FakeWebSocket.CONNECTING;
  public readonly sent: string[] = [];

  constructor(readonly label: string) {
    super();
  }

  send(payload: string): void {
    this.sent.push(payload);
  }

  close(code?: number, reason?: string): void {
    if (this.readyState === FakeWebSocket.CLOSED) return;
    this.readyState = FakeWebSocket.CLOSED;
    this.emit("close", code, reason);
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

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

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
  await sleep(30);
  check(settled, "constructor failure path calls settlement callback");
};

// --- Test 2: stale handlers do not win over newer attempts ----------------

const testStaleAttemptHandlersAreIgnored = async (): Promise<void> => {
  const sockets: FakeWebSocket[] = [];
  const urls = ["ws://attempt-1.invalid:9222", "ws://attempt-2.invalid:9222"];

  const bridge = createCdpBridge({
    discoverWsUrl: async (): Promise<Result<string, CdpError>> => {
      const next = urls.shift();
      if (!next) return { success: false, error: { kind: "discovery_failed", message: "no more urls" } };
      return { success: true, data: next };
    },
    createWebSocket: (url: string): WebSocket => {
      const sock = new FakeWebSocket(url);
      sockets.push(sock);
      return sock as unknown as WebSocket;
    },
    connectTimeoutMs: 30,
  });

  let closeCallbacks = 0;
  bridge.onClose(() => {
    closeCallbacks += 1;
  });

  await bridge.start();
  await sleep(5);

  // Stop while attempt #1 is still in CONNECTING state. This leaves the first
  // socket alive but should not cancel its in-flight close timer.
  await bridge.stop();

  // Restart to start attempt #2.
  await bridge.start();
  await sleep(5);

  check(sockets.length >= 2, "bridge created two connection attempts");
  const first = sockets[0];
  const second = sockets[1];

  // Allow the fresh attempt to win.
  second.open();
  await sleep(5);
  check(bridge.isAlive(), "second socket connected and keeps bridge alive");

  // Let attempt #1's timeout-driven close fire after attempt #2 is active. If
  // stale handlers are not gated by attempt identity, this closes the bridge.
  await sleep(45);
  check(bridge.isAlive(), "stale close event from attempt #1 does not clear active connection");
  check(closeCallbacks === 0, "stale close handler does not invoke onClose callbacks");

  // The stale socket should not receive any ownership influence; opening it after a
  // newer attempt is active should be ignored.
  first.open();
  await sleep(5);
  check(bridge.isAlive(), "stale open event does not replace the active WebSocket");

  await bridge.stop();
};

async function main(): Promise<void> {
  console.log("bridge connection regression tests\n");

  await testConstructorFailureSettlesAttempt();
  await testStaleAttemptHandlersAreIgnored();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((err) => {
  console.error("bridge regression test failed:", err);
  process.exit(1);
});
