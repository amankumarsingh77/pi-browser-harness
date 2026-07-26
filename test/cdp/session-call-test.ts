import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decodeResult } from "../../src/cdp/commands";

describe("typed call decoding", () => {
  test("a valid transport payload decodes to typed data", () => {
    const fromTransport: unknown = { sessionId: "abc123" };
    const r = decodeResult("Target.attachToTarget", fromTransport);
    assert.equal(r.success, true);
    if (r.success) {
      const sid: string = r.data.sessionId;
      assert.equal(sid, "abc123");
    }
  });

  test("a garbage transport payload becomes invalid_response", () => {
    const r = decodeResult("Target.attachToTarget", { sessionId: 42 });
    assert.equal(r.success, false);
    if (!r.success) assert.equal(r.error.kind, "invalid_response");
  });

  test("extra Chrome fields on a result are tolerated", () => {
    const r = decodeResult("Target.getTargetInfo", {
      targetInfo: { targetId: "t", type: "page", title: "T", url: "u", futureField: 1 },
    });
    assert.equal(r.success, true);
  });
});
