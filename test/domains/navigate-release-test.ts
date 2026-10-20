import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { type CannedResult, createFakeClient, type FakeClient, handlerContext } from "./fake-client";
import { openUrlsTool } from "../../src/domains/navigate";
import { cdpError } from "../../src/cdp/errors";
import { err, ok } from "../../src/util/result";

// The fake starts with t1 attached as s1; the new tab t2 gets the second attach result.
const openOneTab = (navigate: CannedResult): Promise<FakeClient> =>
  createFakeClient({
    canned: {
      "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-new" })],
      "Target.createTarget": ok({ targetId: "t2" }),
      "Page.navigate": navigate,
    },
    // readyState poll resolves at once; the title marker returns nothing.
    evaluate: (expression) => ok(expression.includes("readyState") ? true : undefined),
  });

describe("browser_open_urls releases the session it borrows per tab", () => {
  test("after a successful navigation the throwaway session is detached", async () => {
    const fake = await openOneTab(ok({ frameId: "f1" }));
    const r = await openUrlsTool.handler({ urls: ["https://example.test/a"] }, handlerContext(fake.client));
    assert.equal(r.success, true);
    const navigated = fake.callsTo("Page.navigate");
    assert.equal(navigated.length, 1);
    assert.equal(navigated[0]?.sessionId, "s-new");
    assert.deepEqual(fake.callsTo("Target.detachFromTarget").map((c) => c.params), [{ sessionId: "s-new" }]);
    assert.equal(fake.session.sessionFor("t2"), undefined);
    assert.equal(fake.session.sessionFor("t1"), "s1", "the current tab keeps its session");
  });

  test("a failed navigation still detaches the borrowed session", async () => {
    const fake = await openOneTab(err(cdpError("remote_error", "net::ERR_FAILED")));
    const r = await openUrlsTool.handler({ urls: ["https://example.test/a"] }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.deepEqual(fake.callsTo("Target.detachFromTarget").map((c) => c.params), [{ sessionId: "s-new" }]);
  });
});
