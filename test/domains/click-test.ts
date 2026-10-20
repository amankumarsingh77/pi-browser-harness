import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { axNode, createFakeClient, handlerContext } from "./fake-client";
import { clickTool } from "../../src/domains/click";
import { setDebugClicks } from "../../src/util/debug";
import { ok } from "../../src/util/result";

// An AX tree with no interactive nodes, so the post-click diff is empty and the text is just the click line.
const EMPTY_TREE = ok({ nodes: [axNode("1", "RootWebArea", "")] });

// The seeded ref e1 (a textbox named "e1" by the fake) is still there after the click, so the diff stays empty.
const TREE_WITH_E1 = ok({
  nodes: [axNode("1", "RootWebArea", "", { childIds: ["2"] }), axNode("2", "textbox", "e1", { parentId: "1", backendDOMNodeId: 101 })],
});

const BOX_40x20_AT_100x200 = ok({ model: { content: [100, 200, 140, 200, 140, 220, 100, 220], width: 40, height: 20 } });

describe("browser_click by coordinates", () => {
  test("moves, presses and releases at the point, then reports the click", async () => {
    const fake = await createFakeClient({ canned: { "Accessibility.getFullAXTree": EMPTY_TREE } });
    const r = await clickTool.handler({ x: 10, y: 20 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Clicked at (10, 20)");
    assert.deepEqual(r.data.details, { x: 10, y: 20 });

    const mouse = fake.callsTo("Input.dispatchMouseEvent");
    assert.deepEqual(
      mouse.map((c) => c.params),
      [
        { type: "mouseMoved", x: 10, y: 20 },
        { type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1 },
        { type: "mouseReleased", x: 10, y: 20, button: "left", clickCount: 1 },
      ],
    );
    // The diff reads the tree after the mouse sequence, never before it.
    const order = fake.calls.map((c) => c.method);
    assert.equal(order.indexOf("Accessibility.getFullAXTree"), 3);
  });

  test("button and count are forwarded to press and release", async () => {
    const fake = await createFakeClient({ canned: { "Accessibility.getFullAXTree": EMPTY_TREE } });
    const r = await clickTool.handler({ x: 1, y: 2, button: "right", count: 2 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    const [, pressed, released] = fake.callsTo("Input.dispatchMouseEvent");
    assert.equal(pressed?.params["button"], "right");
    assert.equal(pressed.params["clickCount"], 2);
    assert.equal(released?.params["button"], "right");
    assert.equal(released.params["clickCount"], 2);
  });

  test("a failed press is a cdp_error naming the method and nothing further is sent", async () => {
    const fake = await createFakeClient({
      canned: {
        "Input.dispatchMouseEvent": [ok({}), { success: false, error: { kind: "remote_error", message: "no target" } }],
      },
    });
    const r = await clickTool.handler({ x: 1, y: 2 }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "no target");
    assert.deepEqual(r.error.details, { method: "Input.dispatchMouseEvent" });
    assert.equal(fake.callsTo("Input.dispatchMouseEvent").length, 2);
    assert.equal(fake.callsTo("Accessibility.getFullAXTree").length, 0);
  });

  test("a CDP timeout keeps its timeout kind", async () => {
    const fake = await createFakeClient({
      canned: { "Input.dispatchMouseEvent": { success: false, error: { kind: "timeout", message: "slow" } } },
    });
    const r = await clickTool.handler({ x: 1, y: 2 }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
  });

  test("neither ref nor both coordinates is invalid_args before any CDP call", async () => {
    const fake = await createFakeClient();
    const r = await clickTool.handler({ x: 5 }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
    assert.equal(fake.calls.length, 0);
  });
});

describe("browser_click by ref", () => {
  test("resolves the ref to its box centre and clicks there", async () => {
    const fake = await createFakeClient({
      refs: [{ ref: "e1", backendId: 101 }],
      canned: { "DOM.getBoxModel": BOX_40x20_AT_100x200, "Accessibility.getFullAXTree": TREE_WITH_E1 },
    });
    const r = await clickTool.handler({ ref: "e1", x: 999, y: 999 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Clicked at [e1] (120, 210)");
    assert.deepEqual(r.data.details, { x: 120, y: 210, ref: "e1" });
    assert.equal(fake.callsTo("DOM.getBoxModel")[0]?.params["backendNodeId"], 101);
    const pressed = fake.callsTo("Input.dispatchMouseEvent")[1];
    assert.equal(pressed?.params["x"], 120);
    assert.equal(pressed.params["y"], 210);
  });

  test("an unknown ref is invalid_state carrying the ref, with no input sent", async () => {
    const fake = await createFakeClient();
    const r = await clickTool.handler({ ref: "e9" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.match(r.error.message, /stale/);
    assert.deepEqual(r.error.details, { ref: "e9" });
    assert.equal(fake.callsTo("Input.dispatchMouseEvent").length, 0);
  });

  test("a zero-size box is reported as a stale ref rather than clicked at (0, 0)", async () => {
    const fake = await createFakeClient({
      refs: [{ ref: "e1", backendId: 101 }],
      canned: { "DOM.getBoxModel": ok({ model: { content: [0, 0, 0, 0, 0, 0, 0, 0], width: 0, height: 0 } }) },
    });
    const r = await clickTool.handler({ ref: "e1" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.equal(fake.callsTo("Input.dispatchMouseEvent").length, 0);
  });
});

describe("browser_click page diff", () => {
  test("appends what changed in the interactive set after the click", async () => {
    const fake = await createFakeClient({
      refs: [{ ref: "e1", backendId: 101, sig: { role: "textbox", name: "Email", value: "", state: "" } }],
      canned: {
        "Accessibility.getFullAXTree": ok({
          nodes: [
            axNode("1", "RootWebArea", "", { childIds: ["2", "3"] }),
            axNode("2", "textbox", "Email", { parentId: "1", backendDOMNodeId: 101 }),
            axNode("3", "button", "Submit", { parentId: "1", backendDOMNodeId: 102 }),
          ],
        }),
      },
    });
    const r = await clickTool.handler({ x: 1, y: 1 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /^Clicked at \(1, 1\)\nPage changes \(re-snapshot for full tree\):\n/);
    assert.match(r.data.text, /New \(\*\):\n {2}\*\[e2\] button "Submit"/);
  });

  test("a failed tree read is reported inline, not as a failed click", async () => {
    const fake = await createFakeClient({
      canned: { "Accessibility.getFullAXTree": { success: false, error: { kind: "remote_error", message: "AX busy" } } },
    });
    const r = await clickTool.handler({ x: 1, y: 1 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Clicked at (1, 1)\n(page diff unavailable: AX busy)");
  });
});

describe("browser_click debug overlay", () => {
  test("a failed debug capture falls back to the plain result", async () => {
    setDebugClicks(true);
    try {
      const fake = await createFakeClient({
        canned: {
          "Accessibility.getFullAXTree": EMPTY_TREE,
          "Page.captureScreenshot": { success: false, error: { kind: "remote_error", message: "no surface" } },
        },
      });
      const r = await clickTool.handler({ x: 3, y: 4 }, handlerContext(fake.client));
      assert.equal(r.success, true);
      assert.equal(r.data.text, "Clicked at (3, 4)");
      assert.deepEqual(r.data.details, { x: 3, y: 4 });
      assert.equal(fake.callsTo("Page.captureScreenshot").length, 1);
    } finally {
      setDebugClicks(false);
    }
  });

  test("the overlay is not captured when debugging is off", async () => {
    const fake = await createFakeClient({ canned: { "Accessibility.getFullAXTree": EMPTY_TREE } });
    await clickTool.handler({ x: 3, y: 4 }, handlerContext(fake.client));
    assert.equal(fake.callsTo("Page.captureScreenshot").length, 0);
  });
});
