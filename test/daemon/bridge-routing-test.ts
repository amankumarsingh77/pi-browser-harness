import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createEventRouter, createIdMultiplexer, type InFlight } from "../../src/daemon/bridge";
import type { SendToClient } from "../../src/daemon/bridge";
import type { WireEvent } from "../../src/daemon/protocol";

const noSend: SendToClient = () => {};
const entry = (clientId: string, localId: number): Omit<InFlight, "timer"> => ({
  clientId,
  localId,
  send: noSend,
  isAttach: false,
});

const inertTimer = (): ReturnType<typeof setTimeout> => setTimeout(() => {}, 60_000);

describe("daemon id multiplexer", () => {
  test("two clients using the same local id get distinct daemon ids", () => {
    const mux = createIdMultiplexer();
    const a = mux.allocate(entry("client-a", 1), inertTimer);
    const b = mux.allocate(entry("client-b", 1), inertTimer);
    assert.notEqual(a, b);
  });

  test("a response is routed back to the client that asked, with its own id", () => {
    const mux = createIdMultiplexer();
    const a = mux.allocate(entry("client-a", 7), inertTimer);
    const b = mux.allocate(entry("client-b", 7), inertTimer);
    assert.equal(mux.take(b)?.clientId, "client-b");
    const takenA = mux.take(a);
    assert.equal(takenA?.clientId, "client-a");
    assert.equal(takenA?.localId, 7);
  });

  test("taking the same daemon id twice yields nothing the second time", () => {
    const mux = createIdMultiplexer();
    const id = mux.allocate(entry("client-a", 1), inertTimer);
    assert.ok(mux.take(id));
    assert.equal(mux.take(id), undefined);
  });

  test("an unknown daemon id is not mistaken for an in-flight request", () => {
    const mux = createIdMultiplexer();
    assert.equal(mux.take(999), undefined);
  });

  test("clearClient drops only that client's in-flight requests", () => {
    const mux = createIdMultiplexer();
    const a = mux.allocate(entry("client-a", 1), inertTimer);
    const b = mux.allocate(entry("client-b", 1), inertTimer);
    mux.clearClient("client-a");
    assert.equal(mux.take(a), undefined);
    assert.equal(mux.take(b)?.clientId, "client-b");
  });

  test("clearClient cancels the pending timeout so a gone client is never answered", () => {
    const mux = createIdMultiplexer();
    let fired = false;
    mux.allocate(entry("client-a", 1), () => setTimeout(() => { fired = true; }, 1));
    mux.clearClient("client-a");
    return new Promise<void>((resolve) => setTimeout(() => {
      assert.equal(fired, false);
      resolve();
    }, 30));
  });

  test("takeAll drains every in-flight request exactly once", () => {
    const mux = createIdMultiplexer();
    mux.allocate(entry("client-a", 1), inertTimer);
    mux.allocate(entry("client-b", 2), inertTimer);
    assert.equal(mux.takeAll().length, 2);
    assert.equal(mux.takeAll().length, 0);
  });
});

const ev = (sessionId?: string): WireEvent => ({
  type: "event",
  method: "Page.loadEventFired",
  ...(sessionId !== undefined ? { sessionId } : {}),
});

describe("daemon event router", () => {
  test("a session-scoped event goes only to the client owning that session", () => {
    const router = createEventRouter();
    router.record("client-a", "S1");
    router.record("client-b", "S2");
    assert.deepEqual(router.route(ev("S1")), ["client-a"]);
    assert.deepEqual(router.route(ev("S2")), ["client-b"]);
  });

  test("an event for an unknown session goes nowhere rather than to everyone", () => {
    const router = createEventRouter();
    router.record("client-a", "S1");
    assert.deepEqual(router.route(ev("S9")), []);
  });

  test("a session-less event goes to every client that holds a session", () => {
    const router = createEventRouter();
    router.record("client-a", "S1");
    router.record("client-b", "S2");
    assert.deepEqual(router.route(ev()).sort(), ["client-a", "client-b"]);
  });

  test("re-recording a session moves ownership and does not leave it with the old client", () => {
    const router = createEventRouter();
    router.record("client-a", "S1");
    router.record("client-b", "S1");
    assert.equal(router.getOwner("S1"), "client-b");
    assert.deepEqual(router.route(ev("S1")), ["client-b"]);
  });

  test("releasing a session leaves its events unrouted", () => {
    const router = createEventRouter();
    router.record("client-a", "S1");
    router.release("S1");
    assert.equal(router.getOwner("S1"), undefined);
    assert.deepEqual(router.route(ev("S1")), []);
  });

  test("removing a client releases every session it owned", () => {
    const router = createEventRouter();
    router.record("client-a", "S1");
    router.record("client-a", "S2");
    router.record("client-b", "S3");
    router.removeClient("client-a");
    assert.equal(router.getOwner("S1"), undefined);
    assert.equal(router.getOwner("S2"), undefined);
    assert.equal(router.getOwner("S3"), "client-b");
    assert.deepEqual(router.route(ev()), ["client-b"]);
  });
});
