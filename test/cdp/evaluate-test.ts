import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evaluateJson } from "../../src/cdp/evaluate";
import type { CdpSession } from "../../src/cdp/session";
import { ok } from "../../src/util/result";

const isNumberArray = (v: unknown): v is ReadonlyArray<number> =>
  Array.isArray(v) && v.every((x) => typeof x === "number");

const fakeSession = (payload: unknown): CdpSession =>
  ({
    call: async () => ok(payload),
  }) as unknown as CdpSession;

describe("evaluateJson", () => {
  test("unwraps result.value and applies the guard", async () => {
    const s = fakeSession({ result: { type: "object", value: [1, 2, 3] } });
    const r = await evaluateJson(s, "[1,2,3]", isNumberArray);
    assert.equal(r.success, true);
    if (r.success) assert.deepEqual(r.data, [1, 2, 3]);
  });

  test("surfaces a page exception as an error", async () => {
    const s = fakeSession({
      result: { type: "undefined" },
      exceptionDetails: { text: "ReferenceError: x is not defined" },
    });
    const r = await evaluateJson(s, "x", isNumberArray);
    assert.equal(r.success, false);
    if (!r.success) assert.match(r.error.message, /ReferenceError/);
  });

  test("rejects a value that fails the guard", async () => {
    const s = fakeSession({ result: { type: "string", value: "nope" } });
    const r = await evaluateJson(s, "'nope'", isNumberArray);
    assert.equal(r.success, false);
    if (!r.success) assert.equal(r.error.kind, "invalid_response");
  });
});
