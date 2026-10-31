import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { FIND_TIMEOUT_MS, findTarget } from "../../src/recipes/find";
import { ok } from "../../src/util/result";
import { axNode, createFakeClient } from "../domains/fake-client";

const tree = (...nodes: ReadonlyArray<{ readonly role: string; readonly name: string; readonly backendId: number }>) =>
  ok({
    nodes: [
      axNode("1", "RootWebArea", "", { childIds: nodes.map((_, i) => String(i + 2)) }),
      ...nodes.map((n, i) => axNode(String(i + 2), n.role, n.name, { parentId: "1", backendDOMNodeId: n.backendId })),
    ],
  });

describe("findTarget", () => {
  test("SC26: a link \"Download\" locator with nth 2 resolves to the ref of the third same-named link", async () => {
    const fake = await createFakeClient({
      canned: {
        "Accessibility.getFullAXTree": tree(
          { role: "link", name: "Download", backendId: 31 },
          { role: "link", name: "Download", backendId: 32 },
          { role: "link", name: "Download", backendId: 33 },
        ),
      },
    });

    const found = await findTarget(fake.client, { role: "link", name: "Download", nth: 2 });

    assert.ok(found.success && "ref" in found.data, "expected a ref");
    assert.equal(fake.session.resolveRef(found.data.ref), 33);
  });

  test("SC81: a link \"Homepage (g then d)\" locator resolves to the link the page now names \"Homepage ( g then d )\"", async () => {
    const fake = await createFakeClient({
      canned: { "Accessibility.getFullAXTree": tree({ role: "link", name: "Homepage ( g then d )", backendId: 51 }) },
    });

    const found = await findTarget(fake.client, { role: "link", name: "Homepage (g then d)", nth: 0 });

    assert.ok(found.success && "ref" in found.data, "expected a ref");
    assert.equal(fake.session.resolveRef(found.data.ref), 51);
  });

  test("SC82: a button \"Switch repository(alt shift r)\" locator resolves to \"Switch repository ( alt shift r )\", but not to \"Switch repositories\"", async () => {
    const fake = await createFakeClient({
      canned: {
        "Accessibility.getFullAXTree": tree(
          { role: "button", name: "Switch repositories", backendId: 61 },
          { role: "button", name: "Switch  repository ( alt shift r )", backendId: 62 },
        ),
      },
    });

    const found = await findTarget(fake.client, { role: "button", name: "Switch repository(alt shift r)", nth: 0 });

    assert.ok(found.success && "ref" in found.data, "expected a ref");
    assert.equal(fake.session.resolveRef(found.data.ref), 62);
  });

  test("SC27: a button \"Export CSV\" locator that never appears fails after about 5s with a message naming it", async () => {
    const fake = await createFakeClient({
      canned: { "Accessibility.getFullAXTree": tree({ role: "button", name: "Import", backendId: 41 }) },
    });
    const started = Date.now();

    const found = await findTarget(fake.client, { role: "button", name: "Export CSV", nth: 0 });

    const waited = Date.now() - started;
    assert.ok(!found.success, "expected the lookup to fail");
    assert.match(found.error, /button named "Export CSV"/);
    assert.ok(waited >= FIND_TIMEOUT_MS - 50 && waited < FIND_TIMEOUT_MS + 1_000, `waited ${waited}ms`);
  });
});
