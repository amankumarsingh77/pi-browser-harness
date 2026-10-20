// Type-level assertions: this file is checked by `tsc -p tsconfig.test.json`. The runtime test only
// proves the combinators agree with the sample's branch; the @ts-expect-error lines and the Equal
// checks fail at typecheck time.

import { test } from "node:test";
import assert from "node:assert/strict";
import { type Result, andThen, err, map, mapErr, ok, unwrapOr } from "../../src/util/result";

// The two generic signatures are compared as a whole, which is the one comparison TS performs
// without distributing or widening either side.
// eslint-disable-next-line @typescript-eslint/no-unnecessary-type-parameters -- each side needs its own generic for the identity check
type Equal<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
const expectTrue = <T extends true>(value: T): T => value;

const sample: Result<number, string> = Math.random() > 0.5 ? ok(1) : err("e");

// The variant objects are readonly. Type-only probe: never called, because readonly is erased at
// runtime and the assignment would actually mutate `sample`.
export function readonlyProbe(r: Result<number, string>): void {
  if (r.success) {
    // @ts-expect-error data is readonly
    r.data = 2;
  }
}

// Constructors infer the unused side as never, so they assign to any Result.
expectTrue<Equal<ReturnType<typeof ok<number>>, Result<number, never>>>(true);
expectTrue<Equal<ReturnType<typeof err<string>>, Result<never, string>>>(true);
const widened: Result<number, string> = ok(1);
const widenedErr: Result<number, string> = err("e");

// Combinators carry both sides through.
const mapped = map(sample, (n) => String(n));
expectTrue<Equal<typeof mapped, Result<string, string>>>(true);
const chained = andThen(sample, (n) => (n > 0 ? ok(true) : err(42)));
expectTrue<Equal<typeof chained, Result<boolean, string | number>>>(true);
const relabelled = mapErr(sample, (e) => e.length);
expectTrue<Equal<typeof relabelled, Result<number, number>>>(true);
const unwrapped = unwrapOr(sample, 0);
expectTrue<Equal<typeof unwrapped, number>>(true);
// @ts-expect-error the fallback must match the data type
unwrapOr(sample, "zero");

// `satisfies` keeps the literal shape while checking against Result.
const literal = { success: true, data: "x" } as const satisfies Result<string, never>;
expectTrue<Equal<typeof literal.data, "x">>(true);
// @ts-expect-error a Result must carry exactly one of data / error for its branch
({ success: true, error: "x" }) satisfies Result<string, string>;

test("result type assertions compile", () => {
  // Narrowing on `success` exposes exactly one of data / error, and the object carries only that one.
  if (sample.success) {
    expectTrue<Equal<typeof sample.data, number>>(true);
    // @ts-expect-error error is not present on the success branch
    assert.equal(sample.error, undefined);
  } else {
    expectTrue<Equal<typeof sample.error, string>>(true);
    // @ts-expect-error data is not present on the failure branch
    assert.equal(sample.data, undefined);
  }

  // Neither field is reachable before narrowing.
  // @ts-expect-error data requires a success check first
  assert.equal(sample.data, sample.success ? 1 : undefined);
  // @ts-expect-error error requires a failure check first
  assert.equal(sample.error, sample.success ? undefined : "e");

  assert.equal(widened.success, true);
  assert.equal(widenedErr.success, false);
  // Every combinator follows the branch of the sample it was given.
  assert.equal(mapped.success, sample.success);
  assert.equal(chained.success, sample.success);
  assert.equal(relabelled.success, sample.success);
  assert.equal(unwrapped, sample.success ? 1 : 0);
  assert.equal(literal.data, "x");
});
