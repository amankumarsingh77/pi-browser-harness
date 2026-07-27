import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { makeEventQueue, rejectAllPending, sendWithTimeout, type Pending } from "../../src/cdp/event-queue";

describe("event queue iteration", () => {
  test("yields pushed events in order", async () => {
    const q = makeEventQueue();
    q.push({ method: "Page.loadEventFired", params: {} });
    q.push({ method: "Page.frameNavigated", params: {} });
    const seen: string[] = [];
    for await (const ev of q.iter) {
      seen.push(ev.method);
      if (seen.length === 2) break;
    }
    assert.deepEqual(seen, ["Page.loadEventFired", "Page.frameNavigated"]);
  });

  test("ending the queue terminates the iteration after draining the buffer", async () => {
    const q = makeEventQueue();
    q.push({ method: "Page.loadEventFired", params: {} });
    q.end();
    const seen: string[] = [];
    for await (const ev of q.iter) seen.push(ev.method);
    assert.deepEqual(seen, ["Page.loadEventFired"]);
  });

  test("a waiter pending at end() is released", async () => {
    const q = makeEventQueue();
    const done = (async () => {
      const seen: string[] = [];
      for await (const ev of q.iter) seen.push(ev.method);
      return seen;
    })();
    await Promise.resolve();
    q.end();
    assert.deepEqual(await done, []);
  });

  test("push after end() is dropped", async () => {
    const q = makeEventQueue();
    q.end();
    q.push({ method: "Page.loadEventFired", params: {} });
    const seen: string[] = [];
    for await (const ev of q.iter) seen.push(ev.method);
    assert.deepEqual(seen, []);
  });

  test("a waiter is handed the next pushed event directly", async () => {
    const q = makeEventQueue();
    const it = q.iter[Symbol.asyncIterator]();
    const pending = it.next();
    await Promise.resolve();
    q.push({ method: "Runtime.consoleAPICalled", params: { a: 1 } });
    const r = await pending;
    assert.equal(r.done, false);
    assert.deepEqual(r.value, { method: "Runtime.consoleAPICalled", params: { a: 1 } });
  });

  test("the terminal result reports done with an undefined value", async () => {
    const q = makeEventQueue();
    q.end();
    const it = q.iter[Symbol.asyncIterator]();
    const r = await it.next();
    assert.equal(r.done, true);
    assert.equal(r.value, undefined);
  });

  test("sessionId is preserved on yielded events", async () => {
    const q = makeEventQueue();
    q.push({ method: "Page.loadEventFired", params: {}, sessionId: "s1" });
    q.end();
    const seen: Array<string | undefined> = [];
    for await (const ev of q.iter) seen.push(ev.sessionId);
    assert.deepEqual(seen, ["s1"]);
  });
});

describe("pending request bookkeeping", () => {
  test("rejectAllPending settles every entry with transport_closed and clears the map", () => {
    const pending = new Map<number, Pending>();
    const settled: string[] = [];
    for (const id of [1, 2]) {
      pending.set(id, {
        resolve: (r) => settled.push(r.success ? "ok" : r.error.kind),
        timer: setTimeout(() => {}, 10_000),
        method: `M.m${id}`,
      });
    }
    rejectAllPending(pending, "gone");
    assert.deepEqual(settled, ["transport_closed", "transport_closed"]);
    assert.equal(pending.size, 0);
  });

  test("sendWithTimeout resolves transport_closed when send throws synchronously", async () => {
    const pending = new Map<number, Pending>();
    const r = await sendWithTimeout(pending, 7, "M.m", 10_000, "Test", () => {
      throw new Error("socket gone");
    });
    assert.equal(r.success, false);
    if (!r.success) {
      assert.equal(r.error.kind, "transport_closed");
      assert.equal(r.error.message, "socket gone");
      assert.equal(r.error.method, "M.m");
    }
    assert.equal(pending.size, 0);
  });

  test("sendWithTimeout registers a pending entry the caller can resolve", async () => {
    const pending = new Map<number, Pending>();
    let sent = false;
    const p = sendWithTimeout(pending, 9, "M.m", 10_000, "Test", () => {
      sent = true;
    });
    assert.equal(sent, true);
    const entry = pending.get(9);
    assert.notEqual(entry, undefined);
    if (entry) {
      clearTimeout(entry.timer);
      entry.resolve({ success: true, data: { hello: "world" } });
    }
    const r = await p;
    assert.equal(r.success, true);
    if (r.success) assert.deepEqual(r.data, { hello: "world" });
  });

  test("sendWithTimeout resolves a timeout error and drops the pending entry", async () => {
    const pending = new Map<number, Pending>();
    const r = await sendWithTimeout(pending, 11, "M.slow", 1, "Test", () => {});
    assert.equal(r.success, false);
    if (!r.success) {
      assert.equal(r.error.kind, "timeout");
      assert.match(r.error.message, /Test timeout after 1ms: M\.slow/);
    }
    assert.equal(pending.size, 0);
  });
});
