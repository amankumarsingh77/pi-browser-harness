import { Type } from "typebox";
import type { ParamsOf } from "../cdp/commands";
import { safeJs } from "../util/js-template";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { cdpCall, evalJs } from "./cdp-call";
import { runOnElement } from "./element-call";
import { elementFunctionSource } from "./page/inject";
import { dispatchKeyEvent, type KeyEventSpec } from "./page/keyboard.page";
import { prepareTyping, readTypedValue, type TypePrep, type TypedValue } from "./page/fill.page";
import { nativeFill } from "./form";
import { interactiveDiff } from "./ref-resolve";
import { isRecord } from "../util/guards";
import type { BrowserClient } from "../client";

const DISPATCH_KEY_FN = elementFunctionSource(dispatchKeyEvent);

const VIRTUAL_KEY_CODES: Readonly<Record<string, number>> = {
  Enter: 13, Tab: 9, Backspace: 8, Escape: 27, Delete: 46, " ": 32,
  ArrowLeft: 37, ArrowUp: 38, ArrowRight: 39, ArrowDown: 40,
  Home: 36, End: 35, PageUp: 33, PageDown: 34,
  Insert: 45, Shift: 16, Control: 17, Alt: 18, Meta: 91, CapsLock: 20, ContextMenu: 93,
  F1: 112, F2: 113, F3: 114, F4: 115, F5: 116, F6: 117,
  F7: 118, F8: 119, F9: 120, F10: 121, F11: 122, F12: 123,
};

// Windows virtual-key codes for letters and digits are the upper-case ASCII code ("a" and "A" are both 65).
export const virtualKeyCode = (key: string): number => {
  const named = VIRTUAL_KEY_CODES[key];
  if (named !== undefined) return named;
  if (/^[a-z0-9]$/i.test(key)) return key.toUpperCase().charCodeAt(0);
  return key.length === 1 ? key.charCodeAt(0) : 0;
};

// KeyboardEvent.code: the physical key. Pages that check `code` (shortcut handlers) need "KeyA", not "a".
export const physicalCode = (key: string): string => {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^[0-9]$/.test(key)) return `Digit${key}`;
  if (key === " ") return "Space";
  return key;
};

// Chrome only runs an editing shortcut sent over CDP when the event names the command (macOS does not map Cmd+A to
// select-all for synthetic events), so Ctrl/Cmd + A/C/X/V/Z/Y carry it explicitly.
export const editingCommands = (key: string, modifiers: number): ReadonlyArray<string> => {
  const ctrlOrMeta = (modifiers & (2 | 4)) !== 0;
  if (!ctrlOrMeta || (modifiers & 1) !== 0) return [];
  const shift = (modifiers & 8) !== 0;
  switch (key.toLowerCase()) {
    case "a": return shift ? [] : ["selectAll"];
    case "c": return shift ? [] : ["copy"];
    case "x": return shift ? [] : ["cut"];
    case "v": return shift ? [] : ["paste"];
    case "z": return shift ? ["redo"] : ["undo"];
    case "y": return shift ? [] : ["redo"];
    default: return [];
  }
};

const TypeArgs = Type.Object({
  ref: Type.Optional(
    Type.String({ description: "Stable element ref from browser_snapshot (e.g. 'e7'). PREFERRED. The field is focused for you." }),
  ),
  selector: Type.Optional(Type.String({ description: "CSS selector of the field (fallback when no ref)." })),
  text: Type.String({ description: "Text to enter. With `clear` (the default when a field is named) it replaces the field's value; \"\" empties it." }),
  clear: Type.Optional(
    Type.Boolean({
      description:
        "Replace the field's current value (true) or add to it at the cursor (false). Default: true when ref/selector is given, false when typing into the already-focused element.",
    }),
  ),
});

type TypeTarget = { readonly ref?: string | undefined; readonly selector?: string | undefined };

const PREP_FN = elementFunctionSource(prepareTyping);
const READ_FN = elementFunctionSource(readTypedValue);

const isTypePrep = (v: unknown): v is TypePrep => {
  if (!isRecord(v) || typeof v["ok"] !== "boolean") return false;
  if (v["ok"]) return typeof v["kind"] === "string" && typeof v["value"] === "string" && typeof v["tag"] === "string";
  return typeof v["code"] === "string" && typeof v["reason"] === "string";
};

const isTypedValue = (v: unknown): v is TypedValue =>
  isRecord(v) && typeof v["value"] === "string" && typeof v["focused"] === "boolean";

const hasTarget = (t: TypeTarget): boolean => t.ref !== undefined || t.selector !== undefined;

const labelOf = (t: TypeTarget): string => (t.ref !== undefined ? `[${t.ref}]` : t.selector ?? "the focused element");

// Runs an element function on the named field, or on document.activeElement when none is named.
const onField = async (
  client: BrowserClient,
  t: TypeTarget,
  fn: string,
  args: ReadonlyArray<unknown>,
): Promise<Result<unknown, ToolErr>> => {
  if (hasTarget(t)) {
    const r = await runOnElement(client, { ref: t.ref, selector: t.selector, functionDeclaration: fn, args });
    if (!r.success) return r;
    if (!r.data.found) return err({ kind: "invalid_state", message: `No element matched: ${labelOf(t)}` });
    return ok(r.data.value);
  }
  return evalJs(client, "(" + fn + ").apply(document.activeElement, " + safeJs`${args}` + ")");
};

const prepErr = (t: TypeTarget, prep: Extract<TypePrep, { readonly ok: false }>): ToolErr => {
  const where = labelOf(t);
  const hint =
    prep.code === "select" ? " For a <select> use browser_select_option."
    : prep.code === "checkable" ? " For a checkbox or radio use browser_set_checked."
    : prep.code === "not_element" ? " Pass the field's ref, or click it first so it has focus."
    : "";
  return { kind: "invalid_state", message: `Cannot type into ${where}: ${prep.reason}.${hint}`, details: { code: prep.code, ...(prep.tag !== undefined ? { tag: prep.tag } : {}) } };
};

// Backspace with the field's content selected deletes it, the way a user empties a field.
const pressBackspace = async (client: BrowserClient): Promise<Result<void, ToolErr>> => {
  const key = { key: "Backspace", code: "Backspace", windowsVirtualKeyCode: 8, nativeVirtualKeyCode: 8 };
  const down = await cdpCall(client, "Input.dispatchKeyEvent", { type: "keyDown", ...key });
  if (!down.success) return down;
  const up = await cdpCall(client, "Input.dispatchKeyEvent", { type: "keyUp", ...key });
  if (!up.success) return up;
  return ok(undefined);
};

export const typeTool = defineBrowserTool({
  name: "browser_type",
  label: "Browser Type",
  description:
    "Enter text into a field the way a user types: focuses it, replaces its value (or appends with clear:false), fires real input events so autocomplete/suggestion lists open and React/Vue controlled inputs update, then reads the value back. PREFERRED: pass `ref` from browser_snapshot; fallback: a CSS `selector`; with neither, types into the focused element. If typing does not produce the value (date/masked inputs), it falls back to setting the value directly and says so.",
  promptSnippet: "Type text into a field by ref (preferred), selector, or the focused element",
  promptGuidelines: [
    "One tool for all text entry: browser_type({ ref, text }) replaces the field's value; pass clear:false to append; text \"\" empties the field.",
    "Check the value it reports — a page can reformat or reject what was typed.",
    "Suggestion lists open as you type: after browser_type, run browser_snapshot and browser_click the option's ref.",
    "For a <select> use browser_select_option; for a checkbox/radio use browser_set_checked.",
    "For special keys (Enter, Tab, Escape, arrows) use browser_press_key.",
  ],
  parameters: TypeArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const t: TypeTarget = { ref: args.ref, selector: args.selector };
    const named = hasTarget(t);
    const clear = args.clear ?? named;
    const where = labelOf(t);

    const prepRaw = await onField(client, t, PREP_FN, [clear]);
    if (!prepRaw.success) return prepRaw;
    if (!isTypePrep(prepRaw.data)) {
      if (named) return err({ kind: "internal", message: "unexpected page result shape from browser_type", details: { target: where } });
      return err({
        kind: "invalid_state",
        message: "No editable element is focused — typed text would be lost. Pass the field's ref, or click it first.",
      });
    }
    const prep = prepRaw.data;
    if (!prep.ok) {
      if (!named && prep.code !== "disabled" && prep.code !== "readonly") {
        return err({
          kind: "invalid_state",
          message: "No editable element is focused — typed text would be lost. Pass the field's ref, or click it first.",
          details: { activeElement: prep.tag ?? null },
        });
      }
      return err(prepErr(t, prep));
    }

    const typed = clear && args.text === "" ? await pressBackspace(client) : await cdpCall(client, "Input.insertText", { text: args.text });
    if (!typed.success) return typed;

    const readRaw = await onField(client, t, READ_FN, []);
    const after = readRaw.success && isTypedValue(readRaw.data) ? readRaw.data : undefined;
    const expected = clear ? args.text : prep.value + args.text;
    let value = after?.value;
    let note = "";
    if (value !== undefined && value !== expected && clear && named && prep.kind !== "contenteditable") {
      // Typing did not produce the value (a date or masked input, or a handler that swallowed the keys): set it.
      const filled = await nativeFill(client, t, args.text);
      if (filled.success && "value" in filled.data) {
        value = filled.data.value;
        note = " (typing did not take; value set directly)";
      }
    }
    if (value !== undefined && value !== expected) note += ` ⚠ the field holds ${JSON.stringify(value)}, not what was typed — the page reformatted or rejected it`;
    if (after !== undefined && !after.focused && note === "") note = " (the field lost focus after typing)";

    const diff = await interactiveDiff(client);
    const shown = value !== undefined ? ` → value ${JSON.stringify(value)}` : "";
    return ok({
      text: `Typed "${args.text}" into ${where}${shown}${note}${diff}`,
      details: {
        ...(args.ref !== undefined ? { ref: args.ref } : {}),
        ...(args.selector !== undefined ? { selector: args.selector } : {}),
        text: args.text,
        clear,
        ...(value !== undefined ? { value } : {}),
      },
    });
  },
});

const PressKeyArgs = Type.Object({
  key: Type.String({
    description:
      'Key to press. Special keys: Enter, Tab, Backspace, Escape, Delete, ArrowLeft/Up/Right/Down, Home, End, PageUp, PageDown. Space as " "',
  }),
  modifiers: Type.Optional(
    Type.Integer({
      minimum: 0,
      maximum: 15,
      description: "Modifier bitfield: 1=Alt, 2=Ctrl, 4=Meta(Cmd), 8=Shift. Combine with OR.",
    }),
  ),
});

export const pressKeyTool = defineBrowserTool({
  name: "browser_press_key",
  label: "Browser Press Key",
  description:
    "Press a keyboard key. Supports special keys (Enter, Tab, Backspace, Escape, Delete, arrows, Home, End, PageUp, PageDown, Space as ' ') and regular characters. Optional modifier bitfield: 1=Alt, 2=Ctrl, 4=Meta/Cmd, 8=Shift.",
  promptSnippet: "Press a key (Enter, Tab, Escape, arrows, or any character)",
  promptGuidelines: [
    "Use browser_press_key for keyboard shortcuts and navigation keys.",
    "browser_press_key modifiers combine with bitwise OR: Ctrl+Shift = 2|8 = 10.",
  ],
  parameters: PressKeyArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const k = args.key;
    const code = virtualKeyCode(k);
    const modifiers = args.modifiers ?? 0;
    const isChar = k.length === 1;
    const physical = physicalCode(k);
    // A printable character needs a `char` event for the page to receive keypress/textInput and actually insert it; Shift (8) still counts as printable.
    const hasCommandModifier = (modifiers & (1 | 2 | 4)) !== 0;
    const commands = editingCommands(k, modifiers);
    const downParams: ParamsOf<"Input.dispatchKeyEvent"> = {
      type: isChar && hasCommandModifier ? "rawKeyDown" : "keyDown",
      key: k,
      code: physical,
      modifiers,
      ...(code ? { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code } : {}),
      ...(isChar && !hasCommandModifier ? { text: k, unmodifiedText: k } : {}),
      ...(commands.length > 0 ? { commands: [...commands] } : {}),
    };
    const down = await cdpCall(client, "Input.dispatchKeyEvent", downParams);
    if (!down.success) return down;
    if (isChar && !hasCommandModifier) {
      const charEv = await cdpCall(client, "Input.dispatchKeyEvent", { type: "char", text: k, key: k });
      if (!charEv.success) return charEv;
    }
    const up = await cdpCall(client, "Input.dispatchKeyEvent", { type: "keyUp", key: k, code: physical, modifiers });
    if (!up.success) return up;
    return ok({ text: `Pressed: ${k}${modifiers ? ` (modifiers=${modifiers})` : ""}` });
  },
});

const DispatchKeyArgs = Type.Object({
  ref: Type.Optional(
    Type.String({ description: "Stable element ref from browser_snapshot (e.g. 'e7'). PREFERRED over selector." }),
  ),
  selector: Type.Optional(Type.String({ description: "CSS selector of the target element (fallback when no ref)" })),
  key: Type.String({ description: "Key value (e.g., 'Enter', 'a')" }),
  eventType: Type.Optional(
    Type.Union(
      [Type.Literal("keydown"), Type.Literal("keyup"), Type.Literal("keypress")],
      { default: "keydown", description: "Event type to dispatch. Default: keydown" },
    ),
  ),
});

export const dispatchKeyTool = defineBrowserTool({
  name: "browser_dispatch_key",
  label: "Browser Dispatch Key",
  description:
    "Dispatch a DOM KeyboardEvent on a specific element via JS injection. PREFERRED: pass `ref` from browser_snapshot; fallback: a CSS `selector`. Use for React/Vue components that listen to synthetic events more reliably than CDP input.",
  promptSnippet: "Dispatch a DOM KeyboardEvent on an element by ref (preferred) or selector",
  promptGuidelines: [
    "Does NOT insert text (use browser_type or browser_press_key for actual typing).",
    "Try browser_press_key first; only use browser_dispatch_key when the page ignores raw CDP key events.",
    "The event carries keyCode/which (e.g. 13 for Enter) for legacy handlers, but is untrusted (isTrusted === false) — a few libraries may still ignore it.",
  ],
  parameters: DispatchKeyArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const eventType = args.eventType ?? "keydown";
    const target = args.ref ?? args.selector ?? "";
    // Legacy handlers branch on e.keyCode/e.which rather than e.key, so populate both.
    // keypress carries the character code ("a" = 97); keydown/keyup carry the key code ("a" = 65).
    const code = eventType === "keypress" && args.key.length === 1 ? args.key.charCodeAt(0) : virtualKeyCode(args.key);
    if (args.ref !== undefined) {
      // Through runOnElement so the resolved RemoteObject is released after the call.
      const spec: KeyEventSpec = { type: eventType, key: args.key, code };
      const r = await runOnElement(client, { ref: args.ref, functionDeclaration: DISPATCH_KEY_FN, args: [spec] });
      if (!r.success) return r;
      return ok({
        text: `Dispatched ${eventType}('${args.key}') on ${target}`,
        details: { matched: 1, ref: args.ref },
      });
    }
    if (args.selector === undefined) {
      return err({ kind: "invalid_args", message: "Provide either `ref` or `selector`." });
    }
    const expr = safeJs`
      (() => {
        const els = document.querySelectorAll(${args.selector});
        if (els.length === 0) return 0;
        for (const el of els) {
          el.dispatchEvent(new KeyboardEvent(${eventType}, { key: ${args.key}, keyCode: ${code}, which: ${code}, bubbles: true, cancelable: true }));
        }
        return els.length;
      })()
    `;
    const r = await evalJs(client, expr);
    if (!r.success) return r;
    const matched = Number(r.data ?? 0);
    if (matched === 0) {
      return err({
        kind: "invalid_state",
        message: `Selector matched 0 elements: ${args.selector}`,
        details: { matched: 0, selector: args.selector },
      });
    }
    return ok({
      text: `Dispatched ${eventType}('${args.key}') on ${matched} element(s)`,
      details: { matched, selector: args.selector },
    });
  },
});
