import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Compile } from "typebox/compile";
import { Coords, MouseButton } from "../../src/schemas/common";
import { asString, isRecord } from "../../src/util/guards";

const descriptionOf = (schema: unknown): string => (isRecord(schema) ? (asString(schema["description"]) ?? "") : "");

const coords = Compile(Coords);
const mouseButton = Compile(MouseButton);

describe("Coords schema", () => {
  test("accepts numeric x/y, including zero, negatives and fractions", () => {
    assert.equal(coords.Check({ x: 0, y: 0 }), true);
    assert.equal(coords.Check({ x: -3.5, y: 1e6 }), true);
  });

  test("rejects missing or non-numeric coordinates", () => {
    assert.equal(coords.Check({ x: 1 }), false);
    assert.equal(coords.Check({ y: 1 }), false);
    assert.equal(coords.Check({ x: "1", y: 2 }), false);
    assert.equal(coords.Check({ x: null, y: 2 }), false);
    assert.equal(coords.Check({ x: NaN, y: 2 }), false);
    assert.equal(coords.Check({}), false);
    assert.equal(coords.Check(null), false);
    assert.equal(coords.Check([1, 2]), false);
    assert.equal(coords.Check("1,2"), false);
  });

  test("documents both axes for the model", () => {
    assert.match(descriptionOf(Coords.properties.x), /left edge/);
    assert.match(descriptionOf(Coords.properties.y), /top edge/);
  });
});

describe("MouseButton schema", () => {
  test("accepts exactly left, right and middle", () => {
    for (const b of ["left", "right", "middle"]) assert.equal(mouseButton.Check(b), true, b);
  });

  test("rejects other strings, case variants and non-strings", () => {
    for (const v of ["Left", "LEFT", "back", "forward", "", " left", 0, 1, null, undefined, {}, ["left"]]) {
      assert.equal(mouseButton.Check(v), false, JSON.stringify(v));
    }
  });

  test("carries a description listing the allowed values", () => {
    assert.match(descriptionOf(MouseButton), /"left", "right", or "middle"/);
  });
});
