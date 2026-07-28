import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient, axNode } from "./fake-client";
import { interactiveDiff } from "../../src/domains/ref-resolve";
import { ok } from "../../src/util/result";

const SEEDED = [
  { ref: "e1", backendId: 101, sig: "textbox|Email||" },
  { ref: "e2", backendId: 102, sig: "textbox|Name||" },
  { ref: "e3", backendId: 103, sig: "button|Go||" },
];

const treeWithNewButtonFirst = ok({
  nodes: [
    axNode("1", "RootWebArea", "", { childIds: ["9", "2", "3", "4"] }),
    axNode("9", "button", "Dismiss", { parentId: "1", backendDOMNodeId: 999 }),
    axNode("2", "textbox", "Email", { parentId: "1", backendDOMNodeId: 101 }),
    axNode("3", "textbox", "Name", { parentId: "1", backendDOMNodeId: 102 }),
    axNode("4", "button", "Go", { parentId: "1", backendDOMNodeId: 103 }),
  ],
});

const treeUnchanged = ok({
  nodes: [
    axNode("1", "RootWebArea", "", { childIds: ["2", "3", "4"] }),
    axNode("2", "textbox", "Email", { parentId: "1", backendDOMNodeId: 101, value: { value: "a@b.com" } }),
    axNode("3", "textbox", "Name", { parentId: "1", backendDOMNodeId: 102 }),
    axNode("4", "button", "Go", { parentId: "1", backendDOMNodeId: 103 }),
  ],
});

describe("ref stability across a mutation", () => {
  test("an element appearing above the others does not steal their refs", async () => {
    const fake = await createFakeClient({
      refs: SEEDED,
      canned: { "Accessibility.getFullAXTree": treeWithNewButtonFirst },
    });
    await interactiveDiff(fake.client);
    assert.equal(fake.session.resolveRef("e1"), 101);
    assert.equal(fake.session.resolveRef("e2"), 102);
    assert.equal(fake.session.resolveRef("e3"), 103);
  });

  test("a newly appeared element gets a fresh ref rather than an existing one", async () => {
    const fake = await createFakeClient({
      refs: SEEDED,
      canned: { "Accessibility.getFullAXTree": treeWithNewButtonFirst },
    });
    const diff = await interactiveDiff(fake.client);
    assert.equal(fake.session.resolveRef("e4"), 999);
    assert.match(diff, /\*\[e4\] button "Dismiss"/);
  });

  test("refs are unchanged when the interactive set is unchanged", async () => {
    const fake = await createFakeClient({
      refs: SEEDED,
      canned: { "Accessibility.getFullAXTree": treeUnchanged },
    });
    const diff = await interactiveDiff(fake.client);
    assert.equal(fake.session.resolveRef("e1"), 101);
    assert.equal(fake.session.resolveRef("e2"), 102);
    assert.equal(fake.session.resolveRef("e3"), 103);
    assert.match(diff, /\[e1\] textbox "Email": value "" → "a@b.com"/);
  });

  test("every published ref maps to a distinct element", async () => {
    const fake = await createFakeClient({
      refs: SEEDED,
      canned: { "Accessibility.getFullAXTree": treeWithNewButtonFirst },
    });
    await interactiveDiff(fake.client);
    const seen = new Set<number>();
    for (const ref of ["e1", "e2", "e3", "e4"]) {
      const backendId = fake.session.resolveRef(ref);
      assert.ok(backendId !== undefined, `${ref} resolved to nothing`);
      assert.equal(seen.has(backendId), false, `${ref} duplicates another ref's element`);
      seen.add(backendId);
    }
  });
});
