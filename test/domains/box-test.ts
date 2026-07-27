import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { centreOf } from "../../src/domains/box";

describe("box centre", () => {
  test("computes the centre from a content quad", () => {
    const b = centreOf({ content: [10, 20, 110, 20, 110, 70, 10, 70], width: 100, height: 50 });
    assert.equal(b.cx, 60);
    assert.equal(b.cy, 45);
    assert.equal(b.width, 100);
    assert.equal(b.height, 50);
  });

  test("a degenerate zero-size quad yields its own corner, not NaN", () => {
    const b = centreOf({ content: [5, 5, 5, 5, 5, 5, 5, 5], width: 0, height: 0 });
    assert.equal(b.cx, 5);
    assert.equal(b.cy, 5);
    assert.ok(!Number.isNaN(b.cx));
  });
});
