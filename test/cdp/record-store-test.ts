import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createRecordStore } from "../../src/cdp/record-store";

const fill = (store: ReturnType<typeof createRecordStore<number, string>>, n: number): void => {
  for (let i = 1; i <= n; i++) store.set(i, `r${i}`);
};

describe("record store capacity", () => {
  test("holds up to capacity without reporting a loss", () => {
    const store = createRecordStore<number, string>(3);
    fill(store, 3);
    assert.equal([...store.values()].length, 3);
    assert.equal(store.page([...store.values()], undefined).bufferOverflowed, false);
  });

  test("evicts the oldest past capacity and reports the loss", () => {
    const store = createRecordStore<number, string>(3);
    fill(store, 5);
    assert.deepEqual([...store.values()], ["r3", "r4", "r5"]);
    assert.equal(store.page([...store.values()], undefined).bufferOverflowed, true);
  });

  test("the overflow flag is taken, so a second drain reports no new loss", () => {
    const store = createRecordStore<number, string>(2);
    fill(store, 4);
    assert.equal(store.page([], undefined).bufferOverflowed, true);
    assert.equal(store.page([], undefined).bufferOverflowed, false);
  });

  test("clear resets both the records and the overflow flag", () => {
    const store = createRecordStore<number, string>(2);
    fill(store, 4);
    store.clear();
    assert.equal([...store.values()].length, 0);
    assert.equal(store.page([], undefined).bufferOverflowed, false);
  });

  test("get returns the stored object by reference so callers can mutate in place", () => {
    const store = createRecordStore<string, { status?: number }>(4);
    store.set("a", {});
    const held = store.get("a");
    assert.ok(held);
    held.status = 200;
    assert.equal(store.get("a")?.status, 200);
  });

  test("delete removes a record without flagging an overflow", () => {
    const store = createRecordStore<number, string>(4);
    fill(store, 2);
    store.delete(1);
    assert.deepEqual([...store.values()], ["r2"]);
    assert.equal(store.page([], undefined).bufferOverflowed, false);
  });

  test("re-setting an existing key does not grow the store", () => {
    const store = createRecordStore<number, string>(4);
    store.set(1, "first");
    store.set(1, "second");
    assert.deepEqual([...store.values()], ["second"]);
  });
});

describe("record store paging", () => {
  test("total counts every match while records carry only the page", () => {
    const store = createRecordStore<number, string>(100);
    const matched = Array.from({ length: 120 }, (_, i) => `r${i}`);
    const page = store.page(matched, 10);
    assert.equal(page.total, 120);
    assert.equal(page.records.length, 10);
  });

  test("the page is the newest records, not the oldest", () => {
    const store = createRecordStore<number, string>(10);
    const page = store.page(["a", "b", "c"], 2);
    assert.deepEqual(page.records, ["b", "c"]);
  });

  test("an absent limit defaults to 50", () => {
    const store = createRecordStore<number, string>(600);
    const matched = Array.from({ length: 80 }, (_, i) => `r${i}`);
    assert.equal(store.page(matched, undefined).records.length, 50);
  });

  test("a limit above the 500 ceiling is capped", () => {
    const store = createRecordStore<number, string>(1000);
    const matched = Array.from({ length: 700 }, (_, i) => `r${i}`);
    assert.equal(store.page(matched, 9_000).records.length, 500);
  });

  test("a limit larger than the match count returns every match", () => {
    const store = createRecordStore<number, string>(10);
    assert.equal(store.page(["a", "b"], 50).records.length, 2);
  });
});
