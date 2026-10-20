import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient, handlerContext } from "./fake-client";
import { dragAndDropTool } from "../../src/domains/drag";
import { ok } from "../../src/util/result";

const inputEvents = (fake: Awaited<ReturnType<typeof createFakeClient>>) =>
  fake.calls
    .filter((c) => c.method === "Input.dispatchMouseEvent" || c.method === "Input.dispatchDragEvent")
    .map((c) => ({ method: c.method, type: c.params["type"], x: c.params["x"], y: c.params["y"] }));

describe("browser_drag_and_drop", () => {
  test("presses, enters, hovers along five interpolated points, drops and releases, in order", async () => {
    const fake = await createFakeClient();
    const r = await dragAndDropTool.handler({ startX: 0, startY: 0, endX: 100, endY: 50 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Dragged from (0,0) to (100,50)");
    assert.equal(r.data.details, undefined);
    assert.deepEqual(inputEvents(fake), [
      { method: "Input.dispatchMouseEvent", type: "mousePressed", x: 0, y: 0 },
      { method: "Input.dispatchDragEvent", type: "dragEnter", x: 0, y: 0 },
      { method: "Input.dispatchDragEvent", type: "dragOver", x: 20, y: 10 },
      { method: "Input.dispatchDragEvent", type: "dragOver", x: 40, y: 20 },
      { method: "Input.dispatchDragEvent", type: "dragOver", x: 60, y: 30 },
      { method: "Input.dispatchDragEvent", type: "dragOver", x: 80, y: 40 },
      { method: "Input.dispatchDragEvent", type: "dragOver", x: 100, y: 50 },
      { method: "Input.dispatchDragEvent", type: "drop", x: 100, y: 50 },
      { method: "Input.dispatchMouseEvent", type: "mouseReleased", x: 100, y: 50 },
    ]);
    // Every call is on the page session, and nothing else was sent.
    assert.equal(fake.calls.length, 9);
    assert.ok(fake.calls.every((c) => c.sessionId === "s1"));
  });

  test("the mouse press and release are left-button single clicks", async () => {
    const fake = await createFakeClient();
    await dragAndDropTool.handler({ startX: 1, startY: 2, endX: 3, endY: 4 }, handlerContext(fake.client));
    const [pressed, released] = fake.callsTo("Input.dispatchMouseEvent");
    assert.deepEqual(pressed?.params, { type: "mousePressed", x: 1, y: 2, button: "left", clickCount: 1 });
    assert.deepEqual(released?.params, { type: "mouseReleased", x: 3, y: 4, button: "left", clickCount: 1 });
  });

  test("intermediate points are rounded to whole pixels", async () => {
    const fake = await createFakeClient();
    await dragAndDropTool.handler({ startX: 0, startY: 0, endX: 7, endY: 3 }, handlerContext(fake.client));
    const overs = fake.callsTo("Input.dispatchDragEvent").filter((c) => c.params["type"] === "dragOver");
    assert.deepEqual(overs.map((c) => [c.params["x"], c.params["y"]]), [[1, 1], [3, 1], [4, 2], [6, 2], [7, 3]]);
  });

  test("without dataTransfer every drag event carries an empty item list and a copy mask", async () => {
    const fake = await createFakeClient();
    await dragAndDropTool.handler({ startX: 0, startY: 0, endX: 1, endY: 1 }, handlerContext(fake.client));
    const drags = fake.callsTo("Input.dispatchDragEvent");
    assert.equal(drags.length, 7);
    for (const d of drags) {
      assert.deepEqual(d.params["data"], { items: [], dragOperationsMask: 1 });
      assert.equal(d.params["modifiers"], 0);
    }
  });

  test("dataTransfer entries are base64-encoded into the drag payload", async () => {
    const fake = await createFakeClient();
    await dragAndDropTool.handler(
      { startX: 0, startY: 0, endX: 1, endY: 1, dataTransfer: { "text/plain": "hello", "text/uri-list": "https://x.test/" } },
      handlerContext(fake.client),
    );
    const drop = fake.callsTo("Input.dispatchDragEvent").find((c) => c.params["type"] === "drop");
    assert.deepEqual(drop?.params["data"], {
      items: [
        { mimeType: "text/plain", data: Buffer.from("hello").toString("base64") },
        { mimeType: "text/uri-list", data: Buffer.from("https://x.test/").toString("base64") },
      ],
      dragOperationsMask: 1,
    });
  });

  test("a failure mid-sequence stops the sequence and is a cdp_error naming the method", async () => {
    const fake = await createFakeClient({
      canned: {
        "Input.dispatchDragEvent": [ok({}), ok({}), { success: false, error: { kind: "remote_error", message: "drag rejected" } }],
      },
    });
    const r = await dragAndDropTool.handler({ startX: 0, startY: 0, endX: 10, endY: 10 }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "drag rejected");
    assert.deepEqual(r.error.details, { method: "Input.dispatchDragEvent" });
    // mousePressed, dragEnter, dragOver, dragOver(failed) — and no release after the failure.
    assert.equal(fake.calls.length, 4);
    assert.equal(fake.callsTo("Input.dispatchMouseEvent").length, 1);
  });

  test("a failed press sends no drag events at all", async () => {
    const fake = await createFakeClient({
      canned: { "Input.dispatchMouseEvent": { success: false, error: { kind: "timeout", message: "slow" } } },
    });
    const r = await dragAndDropTool.handler({ startX: 0, startY: 0, endX: 10, endY: 10 }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.equal(fake.callsTo("Input.dispatchDragEvent").length, 0);
  });
});
