import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { asArrayOf, asBoolean, asNumber, asRecord, asString, errnoCode, isRecord } from "../../src/util/guards";

describe("isRecord", () => {
  test("accepts plain objects", () => {
    assert.equal(isRecord({}), true);
    assert.equal(isRecord({ a: 1 }), true);
  });

  test("rejects null, arrays and primitives", () => {
    assert.equal(isRecord(null), false);
    assert.equal(isRecord(undefined), false);
    assert.equal(isRecord([]), false);
    assert.equal(isRecord([{ a: 1 }]), false);
    assert.equal(isRecord("s"), false);
    assert.equal(isRecord(0), false);
    assert.equal(isRecord(false), false);
  });
});

describe("scalar readers", () => {
  test("asString accepts only strings", () => {
    assert.equal(asString(""), "");
    assert.equal(asString("x"), "x");
    assert.equal(asString(1), undefined);
    assert.equal(asString(null), undefined);
    assert.equal(asString(undefined), undefined);
    assert.equal(asString({}), undefined);
  });

  test("asNumber accepts only numbers, including 0 and NaN", () => {
    assert.equal(asNumber(0), 0);
    assert.equal(asNumber(-1.5), -1.5);
    assert.equal(Number.isNaN(asNumber(Number.NaN)), true);
    assert.equal(asNumber("1"), undefined);
    assert.equal(asNumber(null), undefined);
  });

  test("asBoolean accepts only booleans", () => {
    assert.equal(asBoolean(false), false);
    assert.equal(asBoolean(true), true);
    assert.equal(asBoolean(0), undefined);
    assert.equal(asBoolean("true"), undefined);
  });

  test("asRecord mirrors isRecord but yields the value", () => {
    assert.deepEqual(asRecord({ a: 1 }), { a: 1 });
    assert.equal(asRecord([]), undefined);
    assert.equal(asRecord(null), undefined);
  });
});

describe("asArrayOf", () => {
  test("parses every element", () => {
    assert.deepEqual(asArrayOf(["a", "b"], asString), ["a", "b"]);
    assert.deepEqual(asArrayOf([], asString), []);
  });

  test("rejects the whole array when any element fails, rather than dropping it", () => {
    assert.equal(asArrayOf(["a", 2], asString), undefined);
    assert.equal(asArrayOf([1, "b"], asString), undefined);
  });

  test("rejects non-arrays", () => {
    assert.equal(asArrayOf({ 0: "a" }, asString), undefined);
    assert.equal(asArrayOf(undefined, asString), undefined);
    assert.equal(asArrayOf("ab", asString), undefined);
  });

  test("treats an element parsed as undefined as a failure", () => {
    assert.equal(asArrayOf([undefined], asString), undefined);
  });
});

describe("errnoCode", () => {
  test("reads .code off a real Error", () => {
    const e = Object.assign(new Error("nope"), { code: "ENOENT" });
    assert.equal(errnoCode(e), "ENOENT");
  });

  test("returns undefined for an Error without a code", () => {
    assert.equal(errnoCode(new Error("plain")), undefined);
  });

  test("returns undefined for a non-string code", () => {
    assert.equal(errnoCode(Object.assign(new Error("x"), { code: 13 })), undefined);
  });

  test("returns undefined for non-Errors that merely carry a code", () => {
    assert.equal(errnoCode({ code: "ENOENT" }), undefined);
    assert.equal(errnoCode("ENOENT"), undefined);
    assert.equal(errnoCode(null), undefined);
  });
});
