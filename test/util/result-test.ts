import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { type Result, andThen, err, map, mapErr, ok, unwrapOr } from "../../src/util/result";

const parse = (s: string): Result<number, string> => {
  const n = Number(s);
  return Number.isNaN(n) ? err(`not a number: ${s}`) : ok(n);
};

describe("Result helpers", () => {
  test("map transforms the data and leaves an error alone", () => {
    assert.deepEqual(map(ok(2), (n) => n * 2), ok(4));
    assert.deepEqual(map(err("e"), (n: number) => n * 2), err("e"));
  });

  test("andThen chains a fallible step", () => {
    assert.deepEqual(andThen(ok("21"), parse), ok(21));
    assert.deepEqual(andThen(ok("x"), parse), err("not a number: x"));
    assert.deepEqual(andThen(err("first"), parse), err("first"));
  });

  test("mapErr transforms the error and leaves data alone", () => {
    assert.deepEqual(mapErr(err("e"), (e) => e.toUpperCase()), err("E"));
    assert.deepEqual(mapErr(ok(1), (e: string) => e.toUpperCase()), ok(1));
  });

  test("unwrapOr yields the data or the fallback", () => {
    assert.equal(unwrapOr(ok(1), 0), 1);
    assert.equal(unwrapOr(err("e"), 0), 0);
  });
});
