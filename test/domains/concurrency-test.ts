import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { deadlineSignal, runLimited } from "../../src/domains/concurrency";

describe("runLimited", () => {
  test("never has more than `limit` tasks in flight", async () => {
    let inFlight = 0;
    let peak = 0;
    const ac = new AbortController();
    const out = await runLimited([1, 2, 3, 4, 5, 6], { limit: 2, signal: ac.signal }, async (n) => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await tick();
      inFlight--;
      return n * 10;
    });
    assert.equal(peak, 2);
    assert.deepEqual(out, [10, 20, 30, 40, 50, 60]);
  });

  test("starts nothing once the signal is aborted and abandons tasks still running", async () => {
    const started: number[] = [];
    const ac = new AbortController();
    const out = await runLimited([1, 2, 3, 4], { limit: 1, signal: ac.signal }, (n, signal) =>
      new Promise<number>((resolve) => {
        started.push(n);
        assert.equal(signal, ac.signal);
        if (n === 2) {
          ac.abort();
          return; // never resolves: the runner must not wait for it
        }
        resolve(n);
      }),
    );
    assert.deepEqual(started, [1, 2]);
    assert.deepEqual(out, [1, undefined, undefined, undefined]);
  });

  test("a task that throws yields undefined for its slot and does not stop the others", async () => {
    const ac = new AbortController();
    const out = await runLimited(["a", "b", "c"], { limit: 3, signal: ac.signal }, (s) => {
      if (s === "b") return Promise.reject(new Error("boom"));
      return Promise.resolve(s.toUpperCase());
    });
    assert.deepEqual(out, ["A", undefined, "C"]);
  });

  test("an already-aborted signal runs nothing", async () => {
    const ac = new AbortController();
    ac.abort();
    let calls = 0;
    const out = await runLimited([1, 2], { limit: 2, signal: ac.signal }, () => {
      calls++;
      return Promise.resolve(1);
    });
    assert.equal(calls, 0);
    assert.deepEqual(out, [undefined, undefined]);
  });
});

describe("deadlineSignal", () => {
  test("fires after the deadline", async () => {
    const d = deadlineSignal(5);
    assert.equal(d.signal.aborted, false);
    await new Promise((resolve) => setTimeout(resolve, 15));
    assert.equal(d.signal.aborted, true);
    d.clear();
  });

  test("follows an aborting parent", () => {
    const parent = new AbortController();
    const d = deadlineSignal(10_000, parent.signal);
    parent.abort();
    assert.equal(d.signal.aborted, true);
    d.clear();
  });
});
