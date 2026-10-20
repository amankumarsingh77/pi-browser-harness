import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient, type FakeClient, handlerContext } from "./fake-client";
import { fillTool, focusTool, selectOptionTool, setCheckedTool } from "../../src/domains/form";
import { ok } from "../../src/util/result";

const RESOLVED_NODE = ok({ object: { type: "object", objectId: "obj-1" } });
const returned = (value: unknown) => ok({ result: { type: "object", value } });

const withRef = async (value: unknown): Promise<FakeClient> =>
  createFakeClient({
    refs: [{ ref: "e1", backendId: 101 }],
    canned: { "DOM.resolveNode": RESOLVED_NODE, "Runtime.callFunctionOn": returned(value) },
  });

describe("a page result of the wrong shape is an internal error, not a missing element", () => {
  test("browser_fill via ref", async () => {
    const fake = await withRef({ status: "ok" });
    const r = await fillTool.handler({ ref: "e1", value: "x" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "internal");
    assert.match(r.error.message, /unexpected page result shape/);
    assert.doesNotMatch(r.error.message, /No element matched/);
  });

  test("browser_fill via selector when the wrapper is intact but the payload is not", async () => {
    const fake = await createFakeClient({ evaluate: () => ok({ found: true, value: 42 }) });
    const r = await fillTool.handler({ selector: "#f", value: "x" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "internal");
    assert.match(r.error.message, /unexpected page result shape/);
  });

  test("browser_fill via selector when even the lookup wrapper is missing", async () => {
    const fake = await createFakeClient({ evaluate: () => ok({ ok: true }) });
    const r = await fillTool.handler({ selector: "#f", value: "x" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "internal");
  });

  test("browser_focus", async () => {
    const fake = await withRef({ ok: true });
    const r = await focusTool.handler({ ref: "e1" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "internal");
    assert.match(r.error.message, /browser_focus/);
  });

  test("browser_select_option", async () => {
    const fake = await withRef({ status: "weird" });
    const r = await selectOptionTool.handler({ ref: "e1", value: "a" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "internal");
    assert.match(r.error.message, /browser_select_option/);
  });

  test("browser_set_checked with a well-formed but non-checkbox result", async () => {
    const fake = await withRef({ ok: true, kind: "input", value: "x", tag: "INPUT" });
    const r = await setCheckedTool.handler({ ref: "e1", checked: true }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "internal");
  });
});

describe("the new page result shapes still drive the happy paths", () => {
  test("browser_fill reports a checkbox result", async () => {
    const fake = await withRef({ ok: true, kind: "checkbox", checked: true, changed: true, tag: "INPUT" });
    const r = await fillTool.handler({ ref: "e1", value: "true" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /Filled e1 = checked=true/);
  });

  test("browser_fill names browser_select_option when the engine rejected a <select>", async () => {
    const fake = await withRef({ ok: false, reason: "element is a <select>", code: "select_rejected", tag: "SELECT" });
    const r = await fillTool.handler({ ref: "e1", value: "x" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.match(r.error.message, /use browser_select_option/);
  });

  test("browser_set_checked reports an unchanged state", async () => {
    const fake = await withRef({ ok: true, kind: "checkbox", checked: false, changed: false, tag: "INPUT" });
    const r = await setCheckedTool.handler({ ref: "e1", checked: false }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /\(already\)/);
  });
});
