import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { borrowSession } from "../../src/cdp/target-factory";
import { cdpError } from "../../src/cdp/errors";
import { err, ok } from "../../src/util/result";
import { createFakeClient } from "../domains/fake-client";

describe("borrowSession", () => {
  test("reuses the tracked session for a target the harness already holds, and release detaches nothing", async () => {
    const fake = await createFakeClient();
    const borrowed = await borrowSession(fake.client, "t1");
    assert.equal(borrowed.success, true);
    assert.equal(borrowed.data.sessionId, "s1");
    assert.equal(fake.callsTo("Target.attachToTarget").length, 0);
    await borrowed.data.release();
    assert.equal(fake.callsTo("Target.detachFromTarget").length, 0);
    assert.equal(fake.session.sessionFor("t1"), "s1", "the tracked session survives a release");
  });

  test("attaches a throwaway session for an untracked target and release detaches exactly it", async () => {
    const fake = await createFakeClient({
      canned: { "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-borrowed" })] },
    });
    const borrowed = await borrowSession(fake.client, "t9");
    assert.equal(borrowed.success, true);
    assert.equal(borrowed.data.sessionId, "s-borrowed");
    assert.deepEqual(fake.callsTo("Target.attachToTarget").map((c) => c.params), [{ targetId: "t9", flatten: true }]);
    await borrowed.data.release();
    assert.deepEqual(fake.callsTo("Target.detachFromTarget").map((c) => c.params), [{ sessionId: "s-borrowed" }]);
    assert.equal(fake.session.sessionFor("t1"), "s1", "the current tab is untouched");
    assert.equal(fake.session.sessionFor("t9"), undefined, "a borrowed session is never tracked");
  });

  test("an attach failure is returned and nothing is detached", async () => {
    const fake = await createFakeClient({
      canned: { "Target.attachToTarget": [ok({ sessionId: "s1" }), err(cdpError("remote_error", "no target"))] },
    });
    const borrowed = await borrowSession(fake.client, "t9");
    assert.equal(borrowed.success, false);
    assert.equal(borrowed.error.message, "no target");
    assert.equal(fake.callsTo("Target.detachFromTarget").length, 0);
  });
});
