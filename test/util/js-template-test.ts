import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { safeJs } from "../../src/util/js-template";

const runInVm = (src: string, sandbox?: Record<string, unknown>): unknown => runInNewContext(src, sandbox);

// Every interpolated value must come back out of a real JS engine as the same value: that is what
// "cannot break out" means, over and above any string-level check. Objects come back from another
// realm (different Object prototype), so structural comparison goes through JSON.
const roundTrip = (value: unknown): unknown => runInVm(safeJs`(${value})`);
const sameJson = (actual: unknown, expected: unknown): void => {
  assert.equal(JSON.stringify(actual), JSON.stringify(expected));
};

describe("safeJs", () => {
  test("primitives are embedded as JSON literals that evaluate back to themselves", () => {
    assert.equal(roundTrip("plain"), "plain");
    assert.equal(roundTrip(42), 42);
    assert.equal(roundTrip(-0.5), -0.5);
    assert.equal(roundTrip(true), true);
    assert.equal(roundTrip(false), false);
    assert.equal(roundTrip(null), null);
  });

  test("objects and arrays round-trip structurally", () => {
    const value = { a: [1, "two", { three: null }], "quoted key": "v" };
    sameJson(roundTrip(value), value);
    sameJson(roundTrip([]), []);
    sameJson(roundTrip({}), {});
  });

  test("undefined is spelled out, so the literal still evaluates", () => {
    assert.equal(safeJs`${undefined}`, "undefined");
    assert.equal(roundTrip(undefined), undefined);
  });

  test("a template with no values is the raw string", () => {
    assert.equal(safeJs`document.title`, "document.title");
  });

  test("several values keep their positions between the literal parts", () => {
    const out = safeJs`f(${"a"}, ${2}, ${[3]})`;
    assert.equal(out, 'f("a", 2, [3])');
    const args = runInVm(`const f = (...xs) => xs; ${out}`);
    assert.ok(Array.isArray(args));
    assert.equal(args.length, 3);
  });

  test("nested templates are embedded as strings, not spliced as code", () => {
    const inner = safeJs`alert(${"x"})`;
    const outer = safeJs`run(${inner})`;
    assert.equal(outer, 'run("alert(\\"x\\")")');
    assert.equal(runInVm(`const run = (s) => s; ${outer}`), inner);
  });

  const injections: ReadonlyArray<string> = [
    `"); alert(1); ("`,
    `'); alert(1); ('`,
    "`); alert(1); (`",
    "${alert(1)}",
    "</script><script>alert(1)</script>",
    " alert(1) ",
    "\\",
    "\\u0022",
    "\n\r\t\0",
    "\u0000",
  ];

  for (const payload of injections) {
    test(`an injection attempt stays a string: ${JSON.stringify(payload)}`, () => {
      const probe = { hit: false };
      const sandbox = { alert: () => { probe.hit = true; }, out: "" };
      runInVm(safeJs`out = ${payload};`, sandbox);
      assert.equal(sandbox.out, payload);
      assert.equal(probe.hit, false);
    });
  }

  test("U+2028 and U+2029 inside a string do not terminate the string literal", () => {
    assert.equal(runInVm(safeJs`${"a b c"}`), "a b c");
  });

  test("keys and values of an object cannot inject code", () => {
    const value = { '"; alert(1); //': "`${alert(1)}`" };
    const sandbox = { hit: false, alert: () => { sandbox.hit = true; }, out: {} };
    runInVm(safeJs`out = ${value};`, sandbox);
    sameJson(sandbox.out, value);
    assert.equal(sandbox.hit, false);
  });

  test("the output is valid JavaScript in a statement context", () => {
    const src = safeJs`const target = ${"sel"}; const n = ${3}; target.repeat(n)`;
    assert.equal(runInVm(src), "selselsel");
  });
});
