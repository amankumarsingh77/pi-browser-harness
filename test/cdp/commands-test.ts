import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, decodeResult } from "../../src/cdp/commands";

describe("cdp command table", () => {
  test("decodes a well-formed response", () => {
    const r = decodeResult("Target.attachToTarget", { sessionId: "s1" });
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.data.sessionId, "s1");
  });

  test("rejects a response with a wrong field type", () => {
    const r = decodeResult("Browser.getWindowForTarget", { windowId: "not-a-number" });
    assert.equal(r.success, false);
    if (!r.success) {
      assert.equal(r.error.kind, "invalid_response");
      assert.equal(r.error.method, "Browser.getWindowForTarget");
      assert.match(r.error.message, /must be number/);
    }
  });

  test("rejects a response missing a required field", () => {
    const r = decodeResult("Target.attachToTarget", {});
    assert.equal(r.success, false);
  });

  test("rejects a non-object response", () => {
    const r = decodeResult("Target.attachToTarget", null);
    assert.equal(r.success, false);
  });

  test("every table entry has both params and result schemas", () => {
    for (const [method, spec] of Object.entries(COMMANDS)) {
      assert.ok(spec.params, `${method} missing params schema`);
      assert.ok(spec.result, `${method} missing result schema`);
      assert.ok(spec.validate, `${method} missing compiled validator`);
    }
  });

  test("an unknown method decodes to an error rather than throwing", () => {
    // Types prevent this, but a daemon could echo an unexpected method name.
    const r = decodeResult("Nope.method" as "Page.enable", {});
    assert.equal(r.success, false);
  });
});
