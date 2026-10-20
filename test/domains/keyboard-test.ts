import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient, handlerContext } from "./fake-client";
import { dispatchKeyTool, pressKeyTool, typeTool } from "../../src/domains/keyboard";
import { ok } from "../../src/util/result";

const FOCUSED_INPUT = ok({ ok: true, tag: "INPUT" });

describe("browser_type", () => {
  test("inserts the text when an editable element is focused", async () => {
    const fake = await createFakeClient({ evaluate: () => FOCUSED_INPUT });
    const r = await typeTool.handler({ text: "hello" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, 'Typed: "hello"');
    assert.equal(r.data.details, undefined);
    assert.equal(fake.evaluated.length, 1);
    assert.match(fake.evaluated[0] ?? "", /document\.activeElement/);
    assert.deepEqual(fake.callsTo("Input.insertText")[0]?.params, { text: "hello" });
  });

  test("refuses when nothing editable is focused, naming the active element, and types nothing", async () => {
    const fake = await createFakeClient({ evaluate: () => ok({ ok: false, tag: "BODY" }) });
    const r = await typeTool.handler({ text: "lost" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.match(r.error.message, /No editable element is focused/);
    assert.deepEqual(r.error.details, { activeElement: "BODY" });
    assert.equal(fake.callsTo("Input.insertText").length, 0);
  });

  test("a probe result of the wrong shape counts as unfocused", async () => {
    const fake = await createFakeClient({ evaluate: () => ok("INPUT") });
    const r = await typeTool.handler({ text: "x" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.deepEqual(r.error.details, { activeElement: null });
  });

  test("a failed focus probe does not block typing", async () => {
    const fake = await createFakeClient({
      evaluate: () => ({ success: false, error: { kind: "remote_error", message: "probe failed" } }),
    });
    const r = await typeTool.handler({ text: "x" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(fake.callsTo("Input.insertText").length, 1);
  });

  test("a failed insert is a cdp_error naming the method", async () => {
    const fake = await createFakeClient({
      evaluate: () => FOCUSED_INPUT,
      canned: { "Input.insertText": { success: false, error: { kind: "remote_error", message: "nope" } } },
    });
    const r = await typeTool.handler({ text: "x" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "nope");
    assert.deepEqual(r.error.details, { method: "Input.insertText" });
  });
});

describe("browser_press_key key parsing", () => {
  test("a named key maps to its virtual key code and sends keyDown then keyUp", async () => {
    const fake = await createFakeClient();
    const r = await pressKeyTool.handler({ key: "Enter" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Pressed: Enter");
    const events = fake.callsTo("Input.dispatchKeyEvent");
    assert.deepEqual(events.map((c) => c.params), [
      { type: "keyDown", key: "Enter", code: "Enter", modifiers: 0, windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 },
      { type: "keyUp", key: "Enter", code: "Enter", modifiers: 0 },
    ]);
  });

  test("each named key gets its own code", async () => {
    const expected: ReadonlyArray<readonly [string, number]> = [
      ["Tab", 9], ["Backspace", 8], ["Escape", 27], ["Delete", 46], ["ArrowLeft", 37], ["ArrowUp", 38],
      ["ArrowRight", 39], ["ArrowDown", 40], ["Home", 36], ["End", 35], ["PageUp", 33], ["PageDown", 34],
    ];
    for (const [key, code] of expected) {
      const fake = await createFakeClient();
      await pressKeyTool.handler({ key }, handlerContext(fake.client));
      const down = fake.callsTo("Input.dispatchKeyEvent")[0];
      assert.equal(down?.params["windowsVirtualKeyCode"], code, key);
      assert.equal(down.params["text"], undefined, `${key} is not printable`);
    }
  });

  test("a printable character adds a char event between keyDown and keyUp, carrying the text", async () => {
    const fake = await createFakeClient();
    const r = await pressKeyTool.handler({ key: "a" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    const events = fake.callsTo("Input.dispatchKeyEvent");
    assert.deepEqual(events.map((c) => c.params), [
      { type: "keyDown", key: "a", code: "a", modifiers: 0, windowsVirtualKeyCode: 97, nativeVirtualKeyCode: 97, text: "a", unmodifiedText: "a" },
      { type: "char", text: "a", key: "a" },
      { type: "keyUp", key: "a", code: "a", modifiers: 0 },
    ]);
  });

  test("space is both a named key (code 32) and printable", async () => {
    const fake = await createFakeClient();
    await pressKeyTool.handler({ key: " " }, handlerContext(fake.client));
    const events = fake.callsTo("Input.dispatchKeyEvent");
    assert.equal(events.length, 3);
    assert.equal(events[0]?.params["windowsVirtualKeyCode"], 32);
    assert.equal(events[0].params["text"], " ");
    assert.equal(events[1]?.params["type"], "char");
  });

  test("a function key carries its virtual key code and no text or char event", async () => {
    const fake = await createFakeClient();
    const r = await pressKeyTool.handler({ key: "F5" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    const events = fake.callsTo("Input.dispatchKeyEvent");
    assert.deepEqual(events.map((c) => c.params), [
      { type: "keyDown", key: "F5", code: "F5", modifiers: 0, windowsVirtualKeyCode: 116, nativeVirtualKeyCode: 116 },
      { type: "keyUp", key: "F5", code: "F5", modifiers: 0 },
    ]);
  });

  test("an unknown multi-character key is sent without virtual key codes, text or char event", async () => {
    const fake = await createFakeClient();
    const r = await pressKeyTool.handler({ key: "Launch0" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    const events = fake.callsTo("Input.dispatchKeyEvent");
    assert.deepEqual(events.map((c) => c.params), [
      { type: "keyDown", key: "Launch0", code: "Launch0", modifiers: 0 },
      { type: "keyUp", key: "Launch0", code: "Launch0", modifiers: 0 },
    ]);
  });

  test("a failed keyDown stops the sequence and is a cdp_error naming the method", async () => {
    const fake = await createFakeClient({
      canned: { "Input.dispatchKeyEvent": { success: false, error: { kind: "remote_error", message: "key rejected" } } },
    });
    const r = await pressKeyTool.handler({ key: "a" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "key rejected");
    assert.deepEqual(r.error.details, { method: "Input.dispatchKeyEvent" });
    assert.equal(fake.callsTo("Input.dispatchKeyEvent").length, 1);
  });

  test("a failed keyUp after a successful char is still an error", async () => {
    const fake = await createFakeClient({
      canned: { "Input.dispatchKeyEvent": [ok({}), ok({}), { success: false, error: { kind: "timeout", message: "slow" } }] },
    });
    const r = await pressKeyTool.handler({ key: "a" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.equal(fake.callsTo("Input.dispatchKeyEvent").length, 3);
  });
});

describe("browser_press_key modifiers", () => {
  test("modifiers are sent on keyDown and keyUp and reported in the text", async () => {
    const fake = await createFakeClient();
    const r = await pressKeyTool.handler({ key: "Enter", modifiers: 10 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Pressed: Enter (modifiers=10)");
    const [down, up] = fake.callsTo("Input.dispatchKeyEvent");
    assert.equal(down?.params["modifiers"], 10);
    assert.equal(up?.params["modifiers"], 10);
  });

  test("Ctrl, Alt and Meta suppress the char event for a printable key (a shortcut, not text)", async () => {
    for (const modifiers of [1, 2, 4, 6]) {
      const fake = await createFakeClient();
      await pressKeyTool.handler({ key: "c", modifiers }, handlerContext(fake.client));
      const types = fake.callsTo("Input.dispatchKeyEvent").map((c) => c.params["type"]);
      assert.deepEqual(types, ["keyDown", "keyUp"], `modifiers=${modifiers}`);
    }
  });

  test("Shift alone keeps the char event, since the key still inserts text", async () => {
    const fake = await createFakeClient();
    await pressKeyTool.handler({ key: "a", modifiers: 8 }, handlerContext(fake.client));
    const types = fake.callsTo("Input.dispatchKeyEvent").map((c) => c.params["type"]);
    assert.deepEqual(types, ["keyDown", "char", "keyUp"]);
  });

  test("modifiers=0 is reported as no modifiers", async () => {
    const fake = await createFakeClient();
    const r = await pressKeyTool.handler({ key: "Tab", modifiers: 0 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Pressed: Tab");
  });
});

describe("browser_dispatch_key by selector", () => {
  test("dispatches a KeyboardEvent on every match and reports the count", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(2) });
    const r = await dispatchKeyTool.handler({ selector: ".row", key: "Enter" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Dispatched keydown('Enter') on 2 element(s)");
    assert.deepEqual(r.data.details, { matched: 2, selector: ".row" });
    const expr = fake.evaluated[0] ?? "";
    assert.match(expr, /querySelectorAll\("\.row"\)/);
    assert.match(expr, /new KeyboardEvent\("keydown", \{ key: "Enter", keyCode: 13, which: 13/);
    assert.equal(fake.calls.length, 0, "no raw CDP input is sent on the selector path");
  });

  test("the event type and a printable key's char code are interpolated", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(1) });
    const r = await dispatchKeyTool.handler({ selector: "#x", key: "a", eventType: "keyup" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Dispatched keyup('a') on 1 element(s)");
    assert.match(fake.evaluated[0] ?? "", /new KeyboardEvent\("keyup", \{ key: "a", keyCode: 97, which: 97/);
  });

  test("a selector containing quotes is JSON-escaped, not spliced raw", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(1) });
    await dispatchKeyTool.handler({ selector: 'input[name="q"]', key: "Enter" }, handlerContext(fake.client));
    assert.match(fake.evaluated[0] ?? "", /querySelectorAll\("input\[name=\\"q\\"\]"\)/);
  });

  test("zero matches is invalid_state carrying the selector", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(0) });
    const r = await dispatchKeyTool.handler({ selector: ".none", key: "Enter" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.deepEqual(r.error.details, { matched: 0, selector: ".none" });
  });

  test("a failed evaluation is a cdp_error attributed to Runtime.evaluate", async () => {
    const fake = await createFakeClient({
      evaluate: () => ({ success: false, error: { kind: "remote_error", message: "boom" } }),
    });
    const r = await dispatchKeyTool.handler({ selector: ".x", key: "Enter" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "boom");
    assert.deepEqual(r.error.details, { method: "Runtime.evaluate" });
  });

  test("neither ref nor selector is invalid_args without evaluating anything", async () => {
    const fake = await createFakeClient();
    const r = await dispatchKeyTool.handler({ key: "Enter" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
    assert.equal(fake.evaluated.length, 0);
  });
});

describe("browser_dispatch_key by ref", () => {
  test("passes the event spec with the legacy key code to the element function", async () => {
    const fake = await createFakeClient({
      refs: [{ ref: "e1", backendId: 101 }],
      canned: {
        "DOM.resolveNode": ok({ object: { type: "object", objectId: "obj-1" } }),
        "Runtime.callFunctionOn": ok({ result: { type: "number", value: 1 } }),
      },
    });
    const r = await dispatchKeyTool.handler({ ref: "e1", selector: ".ignored", key: "Escape", eventType: "keypress" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Dispatched keypress('Escape') on e1");
    assert.deepEqual(r.data.details, { matched: 1, ref: "e1" });
    const call = fake.callsTo("Runtime.callFunctionOn")[0];
    assert.equal(call?.params["objectId"], "obj-1");
    assert.deepEqual(call.params["arguments"], [{ value: { type: "keypress", key: "Escape", code: 27 } }]);
    assert.equal(fake.evaluated.length, 0, "the ref path never falls back to the selector");
  });

  test("a stale ref is invalid_state carrying the ref", async () => {
    const fake = await createFakeClient();
    const r = await dispatchKeyTool.handler({ ref: "e4", key: "Enter" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.deepEqual(r.error.details, { ref: "e4" });
  });
});
