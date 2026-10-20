import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createOwnershipRegistry, reconcileOwnership } from "../../src/cdp/ownership";

describe("OwnershipRegistry.onChange", () => {
  test("every subscriber is notified", () => {
    const reg = createOwnershipRegistry();
    let a = 0;
    let b = 0;
    reg.onChange(() => { a++; });
    reg.onChange(() => { b++; });
    reg.add("t1");
    assert.equal(a, 1);
    assert.equal(b, 1);
  });

  test("the returned disposer removes only that subscriber", () => {
    const reg = createOwnershipRegistry();
    let a = 0;
    let b = 0;
    const off = reg.onChange(() => { a++; });
    reg.onChange(() => { b++; });
    off();
    reg.setHarnessWindow("w");
    assert.equal(a, 0);
    assert.equal(b, 1);
  });

  test("a subscriber that unsubscribes during a notification does not break the others", () => {
    const reg = createOwnershipRegistry();
    let later = 0;
    const off = reg.onChange(() => { off(); });
    reg.onChange(() => { later++; });
    reg.add("t1");
    reg.add("t2");
    assert.equal(later, 2);
  });
});

describe("reconcileOwnership", () => {
  test("drops owned ids that are no longer live and returns the survivors", () => {
    const reg = createOwnershipRegistry({ ownedTargetIds: ["a", "b", "c"] });
    const survivors = reconcileOwnership(reg, new Set(["b", "z"]));
    assert.deepEqual(survivors, ["b"]);
    assert.deepEqual(reg.list(), ["b"]);
  });

  test("clears the harness window when it is dead and keeps it when live", () => {
    const dead = createOwnershipRegistry({ ownedTargetIds: ["a"], harnessWindowTargetId: "a" });
    reconcileOwnership(dead, new Set<string>());
    assert.equal(dead.harnessWindow(), undefined);

    const live = createOwnershipRegistry({ ownedTargetIds: ["a"], harnessWindowTargetId: "a" });
    reconcileOwnership(live, new Set(["a"]));
    assert.equal(live.harnessWindow(), "a");
  });

  test("does not notify when nothing changed", () => {
    const reg = createOwnershipRegistry({ ownedTargetIds: ["a"], harnessWindowTargetId: "a" });
    let notified = 0;
    reg.onChange(() => { notified++; });
    reconcileOwnership(reg, new Set(["a", "b"]));
    assert.equal(notified, 0);
  });
});
