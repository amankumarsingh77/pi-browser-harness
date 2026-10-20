import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient, type FakeClient, handlerContext } from "./fake-client";
import { resolveOwnedTargetId } from "../../src/domains/tab-resolve";
import { closeTabTool, switchTabTool } from "../../src/domains/tabs";
import { ok } from "../../src/util/result";

// "t1" is the tab the fake client attaches to; the rest exercise prefix resolution. Attach prunes ownership to
// live targets, so every owned id must also be listed by Target.getTargets.
const OWNED = ["t1", "AAAAAAAA1111", "AAAAAAAA2222", "BBBBBBBB0000"];

const owned = (): Promise<FakeClient> =>
  createFakeClient({
    ownedTargetIds: OWNED,
    canned: {
      "Target.getTargets": ok({
        targetInfos: OWNED.map((targetId) => ({ targetId, type: "page", title: targetId, url: "https://example.test/" })),
      }),
    },
  });

describe("resolveOwnedTargetId", () => {
  test("an exact owned id resolves to itself", async () => {
    const fake = await owned();
    assert.deepEqual(resolveOwnedTargetId(fake.client, "BBBBBBBB0000"), { success: true, data: "BBBBBBBB0000" });
  });

  test("a unique hex prefix of an owned tab resolves", async () => {
    const fake = await owned();
    assert.deepEqual(resolveOwnedTargetId(fake.client, "BBBBBBBB"), { success: true, data: "BBBBBBBB0000" });
  });

  test("an ambiguous prefix is invalid_args listing the candidates", async () => {
    const fake = await owned();
    const r = resolveOwnedTargetId(fake.client, "AAAAAAAA");
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
    assert.match(r.error.message, /Ambiguous prefix/);
    assert.deepEqual(r.error.details, { matches: ["AAAAAAAA1111", "AAAAAAAA2222"] });
  });

  test("an unowned id and a prefix matching nothing owned are both ownership denials", async () => {
    const fake = await owned();
    for (const input of ["CCCCCCCC0000", "CCCCCCCC", "short"]) {
      const r = resolveOwnedTargetId(fake.client, input);
      assert.equal(r.success, false, input);
      assert.equal(r.error.kind, "invalid_state");
      assert.match(r.error.message, /not owned by this harness session/);
    }
  });

  test("a prefix shorter than 8 characters is not expanded even when unique", async () => {
    const fake = await owned();
    const r = resolveOwnedTargetId(fake.client, "BBBB");
    assert.equal(r.success, false);
  });
});

describe("switch and close share the resolution semantics", () => {
  test("browser_switch_tab refuses an unowned tab without touching the browser", async () => {
    const fake = await owned();
    const r = await switchTabTool.handler({ targetId: "CCCCCCCC0000" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.equal(fake.calls.length, 0);
  });

  test("browser_close_tab reports an ambiguous prefix as invalid_args", async () => {
    const fake = await owned();
    const r = await closeTabTool.handler({ targetId: "AAAAAAAA" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
    assert.equal(fake.callsTo("Target.closeTarget").length, 0);
  });

  test("browser_close_tab resolves a unique prefix and closes that tab", async () => {
    const fake = await owned();
    const r = await closeTabTool.handler({ targetId: "BBBBBBBB" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /Closed tab BBBBBBBB0000/);
  });
});
