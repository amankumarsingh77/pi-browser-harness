import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient, type FakeClient } from "./fake-client";
import { fillTool, focusTool, selectOptionTool } from "../../src/domains/form";
import type { HandlerContext } from "../../src/util/tool";
import { ok } from "../../src/util/result";

const RESOLVED_NODE = ok({ object: { type: "object", objectId: "obj-1" } });

const THREW = ok({
  result: { type: "undefined" },
  exceptionDetails: { text: "Uncaught TypeError: el.dispatchEvent is not a function" },
});

const returned = (value: unknown) => ok({ result: { type: "object", value } });

const ctxFor = (fake: FakeClient): HandlerContext => ({
  client: fake.client,
  signal: undefined,
  onUpdate: () => {},
  extensionCtx: undefined as never,
});

const withRef = async (callResult: ReturnType<typeof ok>): Promise<FakeClient> =>
  createFakeClient({
    refs: [{ ref: "e1", backendId: 101 }],
    canned: { "DOM.resolveNode": RESOLVED_NODE, "Runtime.callFunctionOn": callResult },
  });

describe("a page-side throw is reported as a throw, not as a missing element", () => {
  test("browser_fill surfaces the page exception", async () => {
    const fake = await withRef(THREW);
    const r = await fillTool.handler({ ref: "e1", value: "x" }, ctxFor(fake));
    assert.equal(r.success, false);
    if (r.success) return;
    assert.equal(r.error.kind, "cdp_error");
    assert.doesNotMatch(r.error.message, /No element matched/);
    assert.match(r.error.message, /dispatchEvent is not a function/);
  });

  test("browser_focus surfaces the page exception", async () => {
    const fake = await withRef(THREW);
    const r = await focusTool.handler({ ref: "e1" }, ctxFor(fake));
    assert.equal(r.success, false);
    if (r.success) return;
    assert.equal(r.error.kind, "cdp_error");
    assert.doesNotMatch(r.error.message, /No element matched/);
  });

  test("browser_select_option surfaces the page exception", async () => {
    const fake = await withRef(THREW);
    const r = await selectOptionTool.handler({ ref: "e1", label: "India" }, ctxFor(fake));
    assert.equal(r.success, false);
    if (r.success) return;
    assert.equal(r.error.kind, "cdp_error");
    assert.doesNotMatch(r.error.message, /No element matched/);
  });
});

describe("a genuinely missing element still reports no match", () => {
  test("the selector path reports no match when querySelector finds nothing", async () => {
    const fake = await createFakeClient({
      evaluate: () => ok({ ok: false, reason: "not_found" }),
    });
    const r = await fillTool.handler({ selector: "#nope", value: "x" }, ctxFor(fake));
    assert.equal(r.success, false);
    if (r.success) return;
    assert.equal(r.error.kind, "invalid_state");
    assert.match(r.error.message, /No element matched: #nope/);
  });

  test("a stale ref still reports a stale ref", async () => {
    const fake = await createFakeClient({ refs: [{ ref: "e1", backendId: 101 }] });
    const r = await fillTool.handler({ ref: "e9", value: "x" }, ctxFor(fake));
    assert.equal(r.success, false);
    if (r.success) return;
    assert.match(r.error.message, /unknown or stale/);
  });
});

describe("a well-formed page result still succeeds", () => {
  test("browser_fill reports the value the page read back", async () => {
    const fake = await withRef(returned({ ok: true, kind: "text", value: "typed", tag: "INPUT" }));
    const r = await fillTool.handler({ ref: "e1", value: "typed" }, ctxFor(fake));
    assert.equal(r.success, true);
    if (!r.success) return;
    assert.match(r.data.text, /Filled e1 = "typed"/);
  });

  test("browser_fill refuses a disabled field with the page's reason", async () => {
    const fake = await withRef(returned({ ok: false, reason: "element is disabled", tag: "INPUT" }));
    const r = await fillTool.handler({ ref: "e1", value: "typed" }, ctxFor(fake));
    assert.equal(r.success, false);
    if (r.success) return;
    assert.match(r.error.message, /element is disabled/);
  });
});
