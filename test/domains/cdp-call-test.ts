import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fromClient } from "../../src/domains/cdp-call";
import { cdpError } from "../../src/cdp/errors";
import { err, ok } from "../../src/util/result";

describe("fromClient", () => {
  test("passes a success through unchanged", () => {
    const r = fromClient(ok("t1"), "Target.createTarget");
    assert.deepEqual(r, { success: true, data: "t1" });
  });

  test("keeps the timeout kind and the method the error carries", () => {
    const r = fromClient(err(cdpError("timeout", "slow", "Target.getTargets")), "fallback");
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.equal(r.error.message, "slow");
    assert.deepEqual(r.error.details, { method: "Target.getTargets" });
  });

  test("maps every other kind to cdp_error and names the fallback method when the error has none", () => {
    const r = fromClient(err(cdpError("session_not_found", "gone")), "Page.navigate");
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "Page.navigate" });
  });
});
