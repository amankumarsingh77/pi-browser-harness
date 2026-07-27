import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { parseJson } from "../../src/schemas/parse";

const Pin = Compile(Type.Object({ userDataDir: Type.String(), profileDir: Type.String() }));

describe("parseJson", () => {
  test("parses and validates a well-formed document", () => {
    const r = parseJson('{"userDataDir":"/d","profileDir":"P1"}', Pin);
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.data.profileDir, "P1");
  });

  test("a syntax error becomes an error result, not a throw", () => {
    const r = parseJson("{not json", Pin);
    assert.equal(r.success, false);
    if (!r.success) assert.match(r.error, /JSON/);
  });

  test("a schema mismatch becomes an error result", () => {
    const r = parseJson('{"userDataDir":5}', Pin);
    assert.equal(r.success, false);
  });

  test("a bare JSON scalar does not satisfy an object schema", () => {
    assert.equal(parseJson("42", Pin).success, false);
    assert.equal(parseJson("null", Pin).success, false);
    assert.equal(parseJson('"str"', Pin).success, false);
    assert.equal(parseJson("[]", Pin).success, false);
  });

  test("an error result carries a non-empty message for a schema mismatch", () => {
    const r = parseJson("null", Pin);
    assert.equal(r.success, false);
    if (!r.success) assert.ok(r.error.length > 0);
  });
});
