import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { createMutex } from "../../src/util/mutex";

// Resolves to true only if the promise settles within a few macrotask turns.
const settles = async (p: Promise<unknown>): Promise<boolean> => {
  let done = false;
  void p.then(() => { done = true; }, () => { done = true; });
  for (let i = 0; i < 5; i++) await tick();
  return done;
};

describe("createMutex", () => {
  test("an uncontended acquire resolves immediately", async () => {
    const mutex = createMutex();
    const release = await mutex.acquire();
    assert.equal(typeof release, "function");
    release();
  });

  test("a second acquire waits until the first holder releases", async () => {
    const mutex = createMutex();
    const release = await mutex.acquire();
    const second = mutex.acquire();
    assert.equal(await settles(second), false, "second acquire must not resolve while held");
    release();
    assert.equal(await settles(second), true);
    (await second)();
  });

  test("waiters are served in FIFO order", async () => {
    const mutex = createMutex();
    const order: number[] = [];
    const worker = async (id: number): Promise<void> => {
      const release = await mutex.acquire();
      order.push(id);
      await tick();
      release();
    };
    await Promise.all([worker(1), worker(2), worker(3), worker(4)]);
    assert.deepEqual(order, [1, 2, 3, 4]);
  });

  test("critical sections never overlap under concurrent acquisition", async () => {
    const mutex = createMutex();
    let inside = 0;
    let maxInside = 0;
    const worker = async (): Promise<void> => {
      const release = await mutex.acquire();
      inside++;
      maxInside = Math.max(maxInside, inside);
      await tick();
      await tick();
      inside--;
      release();
    };
    await Promise.all(Array.from({ length: 8 }, () => worker()));
    assert.equal(maxInside, 1);
  });

  test("a holder that throws still lets the next waiter in when it releases in finally", async () => {
    const mutex = createMutex();
    const failing = async (): Promise<void> => {
      const release = await mutex.acquire();
      try {
        throw new Error("boom");
      } finally {
        release();
      }
    };
    await assert.rejects(failing(), /boom/);
    const next = mutex.acquire();
    assert.equal(await settles(next), true, "the lock must be free after the throwing holder released");
    (await next)();
  });

  test("a holder that throws without releasing keeps the lock (nothing releases on its behalf)", async () => {
    const mutex = createMutex();
    const leaky = async (): Promise<void> => {
      await mutex.acquire();
      throw new Error("leak");
    };
    await assert.rejects(leaky(), /leak/);
    assert.equal(await settles(mutex.acquire()), false);
  });

  test("releasing twice does not hand the lock to two waiters", async () => {
    const mutex = createMutex();
    const release = await mutex.acquire();
    const a = mutex.acquire();
    const b = mutex.acquire();
    release();
    release();
    assert.equal(await settles(a), true);
    assert.equal(await settles(b), false, "the second release must be a no-op");
    (await a)();
    assert.equal(await settles(b), true);
    (await b)();
  });

  test("the mutex is not reentrant: a nested acquire by the holder waits for its own release", async () => {
    const mutex = createMutex();
    const release = await mutex.acquire();
    const nested = mutex.acquire();
    assert.equal(await settles(nested), false);
    release();
    assert.equal(await settles(nested), true);
    (await nested)();
  });

  test("separate mutexes do not block each other", async () => {
    const a = createMutex();
    const b = createMutex();
    const releaseA = await a.acquire();
    assert.equal(await settles(b.acquire()), true);
    releaseA();
  });
});
