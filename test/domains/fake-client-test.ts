import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient } from "./fake-client";
import { ok } from "../../src/util/result";

describe("fake browser client", () => {
  test("attaches through the real session and reports a current tab", async () => {
    const fake = await createFakeClient();
    assert.deepEqual(fake.client.current(), { targetId: "t1", sessionId: "s1" });
    assert.equal(fake.client.owns("t1"), true);
  });

  test("routes typed calls through the real decoder, so a bad payload fails", async () => {
    const fake = await createFakeClient({
      canned: { "DOM.getBoxModel": ok({ model: { width: 10 } }) },
    });
    const r = await fake.session.call("DOM.getBoxModel", { backendNodeId: 3 });
    assert.equal(r.success, false);
    if (!r.success) assert.equal(r.error.kind, "invalid_response");
  });

  test("unconfigured client methods fail loudly instead of returning success", async () => {
    const fake = await createFakeClient();
    const r = await fake.client.evaluateJs("1");
    assert.equal(r.success, false);
    if (!r.success) assert.match(r.error.message, /not configured/);
  });

  test("seeded refs resolve through the real ref map", async () => {
    const fake = await createFakeClient({ refs: [{ ref: "e1", backendId: 42 }] });
    assert.equal(fake.session.resolveRef("e1"), 42);
    assert.equal(fake.session.resolveRef("e2"), undefined);
  });
});
