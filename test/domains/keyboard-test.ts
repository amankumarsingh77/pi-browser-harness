import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { axNode, createFakeClient, handlerContext } from "./fake-client";
import { dispatchKeyTool, editingCommands, physicalCode, pressKeyTool, typeTool, virtualKeyCode } from "../../src/domains/keyboard";
import { ok } from "../../src/util/result";

const RESOLVED_NODE = ok({ object: { type: "object", objectId: "obj-1" } });
const EMPTY_TREE = ok({ nodes: [axNode("1", "RootWebArea", "")] });
// The seeded ref e1 is still on the page after typing, so the page diff stays empty.
const TREE_WITH_E1 = ok({
  nodes: [axNode("1", "RootWebArea", "", { childIds: ["2"] }), axNode("2", "textbox", "e1", { parentId: "1", backendDOMNodeId: 101 })],
});
const returned = (value: unknown) => ok({ result: { type: "object", value } });

const PREP_INPUT = (value = "") => ({ ok: true, kind: "input", value, tag: "INPUT" });
const READ_BACK = (value: string, focused = true) => ({ value, focused });

// A client with ref e1 on a field; the page functions answer in order: prepare, read back, then (if used) native fill.
const fieldClient = (...answers: ReadonlyArray<unknown>) =>
  createFakeClient({
    refs: [{ ref: "e1", backendId: 101 }],
    canned: {
      "DOM.resolveNode": RESOLVED_NODE,
      "Runtime.callFunctionOn": answers.map(returned),
      "Accessibility.getFullAXTree": TREE_WITH_E1,
    },
  });

describe("browser_type into a named field", () => {
  test("focuses and selects the field, types with real input events, and reports the value read back", async () => {
    const fake = await fieldClient(PREP_INPUT("old"), READ_BACK("hello"));
    const r = await typeTool.handler({ ref: "e1", text: "hello" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, 'Typed "hello" into [e1] → value "hello"');
    assert.deepEqual(r.data.details, { ref: "e1", text: "hello", clear: true, value: "hello" });
    // The prepare call is told to clear (select all) because a field was named.
    const prep = fake.callsTo("Runtime.callFunctionOn")[0];
    assert.deepEqual(prep?.params["arguments"], [{ value: true }]);
    assert.deepEqual(fake.callsTo("Input.insertText")[0]?.params, { text: "hello" });
  });

  test("clear:false appends at the cursor and expects the old value plus the text", async () => {
    const fake = await fieldClient(PREP_INPUT("Back "), READ_BACK("Back End"));
    const r = await typeTool.handler({ ref: "e1", text: "End", clear: false }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, 'Typed "End" into [e1] → value "Back End"');
    assert.deepEqual(fake.callsTo("Runtime.callFunctionOn")[0]?.params["arguments"], [{ value: false }]);
  });

  test("empty text with clear presses Backspace on the selection instead of inserting nothing", async () => {
    const fake = await fieldClient(PREP_INPUT("Other"), READ_BACK(""));
    const r = await typeTool.handler({ ref: "e1", text: "" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(fake.callsTo("Input.insertText").length, 0);
    const keys = fake.callsTo("Input.dispatchKeyEvent").map((c) => [c.params["type"], c.params["key"]]);
    assert.deepEqual(keys, [["keyDown", "Backspace"], ["keyUp", "Backspace"]]);
  });

  test("when typing does not produce the value it falls back to setting it directly, and says so", async () => {
    const fake = await fieldClient(
      PREP_INPUT(""),
      READ_BACK(""),
      { ok: true, kind: "input", value: "2026-11-07", tag: "INPUT" },
    );
    const r = await typeTool.handler({ ref: "e1", text: "2026-11-07" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /→ value "2026-11-07" \(typing did not take; value set directly\)/);
    assert.equal(fake.callsTo("Runtime.callFunctionOn").length, 3);
  });

  test("a value the page reformatted is reported with a warning, not as success-as-typed", async () => {
    const fake = await fieldClient(PREP_INPUT(""), READ_BACK("+91 98765"), { ok: true, kind: "input", value: "+91 98765", tag: "INPUT" });
    const r = await typeTool.handler({ ref: "e1", text: "98765" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /⚠ the field holds "\+91 98765"/);
  });

  test("a <select> is refused with a pointer to browser_select_option, and nothing is typed", async () => {
    const fake = await fieldClient({ ok: false, code: "select", reason: "element is a <select>", tag: "SELECT" });
    const r = await typeTool.handler({ ref: "e1", text: "x" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.match(r.error.message, /browser_select_option/);
    assert.equal(fake.callsTo("Input.insertText").length, 0);
  });

  test("a checkbox is refused with a pointer to browser_set_checked", async () => {
    const fake = await fieldClient({ ok: false, code: "checkable", reason: "element is a checkbox", tag: "INPUT" });
    const r = await typeTool.handler({ ref: "e1", text: "true" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.match(r.error.message, /browser_set_checked/);
  });

  test("an unknown ref is a stale-ref error before anything is typed", async () => {
    const fake = await createFakeClient();
    const r = await typeTool.handler({ ref: "e9", text: "x" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.match(r.error.message, /stale/);
    assert.equal(fake.callsTo("Input.insertText").length, 0);
  });
});

describe("browser_type into the focused element", () => {
  test("appends by default (no field named) and reports the value", async () => {
    const answers = [PREP_INPUT("Back "), READ_BACK("Back End")];
    const fake = await createFakeClient({ evaluate: () => ok(answers.shift()), canned: { "Accessibility.getFullAXTree": EMPTY_TREE } });
    const r = await typeTool.handler({ text: "End" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, 'Typed "End" into the focused element → value "Back End"');
    assert.match(fake.evaluated[0] ?? "", /document\.activeElement/);
    assert.match(fake.evaluated[0] ?? "", /\[false\]\)$/);
    assert.deepEqual(fake.callsTo("Input.insertText")[0]?.params, { text: "End" });
  });

  test("refuses when nothing editable is focused, naming the active element, and types nothing", async () => {
    const fake = await createFakeClient({ evaluate: () => ok({ ok: false, code: "not_editable", reason: "not a text field", tag: "BODY" }) });
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
    assert.equal(fake.callsTo("Input.insertText").length, 0);
  });

  test("a failed insert is a cdp_error naming the method", async () => {
    const fake = await createFakeClient({
      evaluate: () => ok(PREP_INPUT()),
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
      { type: "keyDown", key: "a", code: "KeyA", modifiers: 0, windowsVirtualKeyCode: 65, nativeVirtualKeyCode: 65, text: "a", unmodifiedText: "a" },
      { type: "char", text: "a", key: "a" },
      { type: "keyUp", key: "a", code: "KeyA", modifiers: 0 },
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
      assert.deepEqual(types, ["rawKeyDown", "keyUp"], `modifiers=${modifiers}`);
      assert.equal(fake.callsTo("Input.dispatchKeyEvent")[0]?.params["text"], undefined, "a shortcut inserts no text");
    }
  });

  test("Cmd/Ctrl+A carries the selectAll editing command, which Chrome needs to run the shortcut", async () => {
    for (const modifiers of [2, 4]) {
      const fake = await createFakeClient();
      await pressKeyTool.handler({ key: "a", modifiers }, handlerContext(fake.client));
      const down = fake.callsTo("Input.dispatchKeyEvent")[0];
      assert.deepEqual(down?.params["commands"], ["selectAll"], `modifiers=${modifiers}`);
      assert.equal(down.params["code"], "KeyA");
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
    assert.match(fake.evaluated[0] ?? "", /new KeyboardEvent\("keyup", \{ key: "a", keyCode: 65, which: 65/);
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

describe("key helpers", () => {
  test("virtual key codes for letters and digits are the upper-case ASCII code", () => {
    assert.equal(virtualKeyCode("a"), 65);
    assert.equal(virtualKeyCode("Z"), 90);
    assert.equal(virtualKeyCode("7"), 55);
    assert.equal(virtualKeyCode("Enter"), 13);
    assert.equal(virtualKeyCode("-"), 45);
  });

  test("physical codes name the key, not the character", () => {
    assert.equal(physicalCode("a"), "KeyA");
    assert.equal(physicalCode("5"), "Digit5");
    assert.equal(physicalCode(" "), "Space");
    assert.equal(physicalCode("Enter"), "Enter");
  });

  test("editing commands map the clipboard/undo shortcuts and nothing else", () => {
    assert.deepEqual(editingCommands("a", 4), ["selectAll"]);
    assert.deepEqual(editingCommands("c", 2), ["copy"]);
    assert.deepEqual(editingCommands("v", 4), ["paste"]);
    assert.deepEqual(editingCommands("z", 4 | 8), ["redo"]);
    assert.deepEqual(editingCommands("a", 0), []);
    assert.deepEqual(editingCommands("a", 8), []);
    assert.deepEqual(editingCommands("a", 4 | 1), [], "Alt changes the shortcut");
    assert.deepEqual(editingCommands("q", 4), []);
  });
});
