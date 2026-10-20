import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient, type FakeClient, handlerContext, type Canned } from "./fake-client";
import { alwaysPageInfo, dialogOf, pageInfoError, pageInfoOf, withClient } from "./client-overrides";
import { scrollTool } from "../../src/domains/scroll";
import type { BrowserClient } from "../../src/client";
import { cdpError } from "../../src/cdp/errors";
import { err, ok } from "../../src/util/result";

const scrollable = async (canned: Canned = {}, viewport?: { width: number; height: number }): Promise<{ fake: FakeClient; client: BrowserClient }> => {
  const fake = await createFakeClient({ canned });
  const client = withClient(fake.client, { pageInfo: alwaysPageInfo(pageInfoOf(viewport)) });
  return { fake, client };
};

describe("browser_scroll", () => {
  test("defaults to a 300px downward wheel at the viewport centre, after focusing and positioning the mouse", async () => {
    const { fake, client } = await scrollable();
    const r = await scrollTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.deepEqual(fake.calls.map((c) => [c.method, c.params]), [
      ["Page.bringToFront", {}],
      ["Input.dispatchMouseEvent", { type: "mouseMoved", x: 500, y: 300, button: "none", buttons: 0 }],
      ["Input.dispatchMouseEvent", {
        type: "mouseWheel", x: 500, y: 300, deltaX: 0, deltaY: 300, button: "none", buttons: 0, pointerType: "mouse",
      }],
    ]);
    assert.ok(fake.calls.every((c) => c.sessionId === "s1"), "every input event goes to the page session");
    assert.equal(r.data.text, "Scrolled at (500, 300) by (0, 300)");
    assert.deepEqual(r.data.details, { x: 500, y: 300, deltaX: 0, deltaY: 300 });
  });

  test("explicit coordinates and deltas are used verbatim, including negative (upward) deltas", async () => {
    const { fake, client } = await scrollable();
    const r = await scrollTool.handler({ x: 40, y: 80, deltaX: -10, deltaY: -250 }, handlerContext(client));
    assert.equal(r.success, true);
    const wheel = fake.callsTo("Input.dispatchMouseEvent")[1];
    assert.ok(wheel);
    assert.equal(wheel.params["x"], 40);
    assert.equal(wheel.params["y"], 80);
    assert.equal(wheel.params["deltaX"], -10);
    assert.equal(wheel.params["deltaY"], -250);
    assert.equal(r.data.text, "Scrolled at (40, 80) by (-10, -250)");
  });

  test("an odd viewport is centred on a rounded integer", async () => {
    const { client } = await scrollable({}, { width: 1001, height: 601 });
    const r = await scrollTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.deepEqual(r.data.details, { x: 501, y: 301, deltaX: 0, deltaY: 300 });
  });

  test("a zero coordinate is honoured rather than replaced by the default", async () => {
    const { client } = await scrollable();
    const r = await scrollTool.handler({ x: 0, y: 0, deltaY: 0 }, handlerContext(client));
    assert.equal(r.success, true);
    assert.deepEqual(r.data.details, { x: 0, y: 0, deltaX: 0, deltaY: 0 });
  });

  test("an open dialog is invalid_state and no input is dispatched", async () => {
    const fake = await createFakeClient();
    const client = withClient(fake.client, {
      pageInfo: alwaysPageInfo(dialogOf({ type: "confirm", message: "Leave?" })),
    });
    const r = await scrollTool.handler({}, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.equal(r.error.message, "Dialog open: confirm — Leave?");
    assert.equal(fake.calls.length, 0);
  });

  test("a page-info failure is reported with its method before anything is sent", async () => {
    const fake = await createFakeClient();
    const client = withClient(fake.client, {
      pageInfo: alwaysPageInfo(pageInfoError("session_not_found", "gone", "Runtime.evaluate")),
    });
    const r = await scrollTool.handler({}, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "Runtime.evaluate" });
    assert.equal(fake.calls.length, 0);
  });

  test("a bringToFront failure stops before any mouse event", async () => {
    const { fake, client } = await scrollable({ "Page.bringToFront": err(cdpError("remote_error", "no page")) });
    const r = await scrollTool.handler({}, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "Page.bringToFront" });
    assert.equal(fake.callsTo("Input.dispatchMouseEvent").length, 0);
  });

  test("a failed mouse move stops before the wheel event", async () => {
    const { fake, client } = await scrollable({
      "Input.dispatchMouseEvent": [err(cdpError("remote_error", "dropped")), ok({})],
    });
    const r = await scrollTool.handler({}, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.message, "dropped");
    assert.equal(fake.callsTo("Input.dispatchMouseEvent").length, 1);
  });

  test("a wheel event timeout keeps the timeout kind", async () => {
    const { fake, client } = await scrollable({
      "Input.dispatchMouseEvent": [ok({}), err(cdpError("timeout", "wheel hung"))],
    });
    const r = await scrollTool.handler({}, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.deepEqual(r.error.details, { method: "Input.dispatchMouseEvent" });
    assert.equal(fake.callsTo("Input.dispatchMouseEvent").length, 2);
  });
});
