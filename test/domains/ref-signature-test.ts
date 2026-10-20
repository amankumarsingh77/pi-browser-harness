import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { RefSignature } from "../../src/domains/ref-signature";
import { diffSignatures, refreshRefs } from "../../src/domains/ref-resolve";
import { axNode, createFakeClient } from "./fake-client";
import { ok } from "../../src/util/result";

const sig = (role: string, name: string, value = "", state = ""): RefSignature => ({ role, name, value, state });

describe("diffSignatures is pure", () => {
  test("reports appeared, changed and removed without touching its inputs", () => {
    const prev = new Map<string, RefSignature>([
      ["e1", sig("textbox", "Email", "")],
      ["e2", sig("button", "Save | Cancel")],
      ["e3", sig("link", "Gone")],
    ]);
    const cur = new Map<string, RefSignature>([
      ["e1", sig("textbox", "Email", "a@b.com")],
      ["e2", sig("button", "Save | Cancel")],
      ["e4", sig("button", "New")],
    ]);
    const prevBefore = new Map(prev);
    const curBefore = new Map(cur);
    const out = diffSignatures(prev, cur);
    assert.match(out, /\[e1\] textbox "Email": value "" → "a@b.com"/);
    assert.match(out, /\*\[e4\] button "New"/);
    assert.match(out, /Removed:\n {2}link "Gone"/);
    assert.doesNotMatch(out, /Save \| Cancel/, "an unchanged element is not reported");
    assert.deepEqual(prev, prevBefore);
    assert.deepEqual(cur, curBefore);
  });

  test("a name containing a pipe is matched as one key", () => {
    const prev = new Map<string, RefSignature>([["e1", sig("button", "Save | Cancel", "", "")]]);
    const cur = new Map<string, RefSignature>([["e1", sig("button", "Save | Cancel", "", "disabled")]]);
    const out = diffSignatures(prev, cur);
    assert.match(out, /\[e1\] button "Save \| Cancel": state "" → "disabled"/);
    assert.doesNotMatch(out, /New \(\*\)/);
    assert.doesNotMatch(out, /Removed:/);
  });

  test("returns the empty string when nothing changed", () => {
    const m = new Map<string, RefSignature>([["e1", sig("link", "Home")]]);
    assert.equal(diffSignatures(m, m), "");
  });
});

describe("refreshRefs", () => {
  test("returns a Result and stores the signature structs on the session", async () => {
    const fake = await createFakeClient({
      refs: [{ ref: "e1", backendId: 101, sig: sig("button", "Save | Cancel") }],
      canned: {
        "Accessibility.getFullAXTree": ok({
          nodes: [
            axNode("1", "RootWebArea", "", { childIds: ["2"] }),
            axNode("2", "button", "Save | Cancel", { parentId: "1", backendDOMNodeId: 101 }),
          ],
        }),
      },
    });
    const r = await refreshRefs(fake.client);
    assert.equal(r.success, true);
    assert.deepEqual(r.data.prev.get("e1"), sig("button", "Save | Cancel"));
    assert.deepEqual(r.data.cur.get("e1"), sig("button", "Save | Cancel"));
    assert.deepEqual(fake.session.refSignatures().get("e1"), sig("button", "Save | Cancel"));
    assert.equal(diffSignatures(r.data.prev, r.data.cur), "");
  });

  test("a CDP failure is an error, not an empty diff", async () => {
    const fake = await createFakeClient({
      canned: {
        "Accessibility.getFullAXTree": { success: false, error: { kind: "timeout", message: "slow" } },
      },
    });
    const r = await refreshRefs(fake.client);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
  });
});
