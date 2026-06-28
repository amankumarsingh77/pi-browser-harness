import { Type } from "typebox";
import { safeJs } from "../util/js-template";
import { virtualKeyCode } from "../util/keycodes";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { resolveRefToObjectId } from "./ref-resolve";

const TypeArgs = Type.Object({
  text: Type.String({ description: "Text to type" }),
});

export const typeTool = defineBrowserTool({
  name: "browser_type",
  label: "Browser Type",
  description: "Type text into the currently focused element. Use browser_click first to focus an input field.",
  promptSnippet: "Type text into the focused element",
  promptGuidelines: [
    "Use browser_type to enter text. Click on an input field with browser_click first to focus it.",
    "For special keys (Enter, Tab, Escape, arrows), use browser_press_key instead.",
  ],
  parameters: TypeArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    // Guard against silent text loss: Input.insertText succeeds regardless of
    // whether an editable element is focused, so without this check typed text
    // can vanish into the void with no error. Fail loudly with an actionable
    // message instead. IIFE starts with "(" so evaluateJs returns it directly.
    const focused = await client.evaluateJs(safeJs`
      (() => {
        const el = document.activeElement;
        const ok = !!el && el !== document.body &&
          (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
        return { ok, tag: el ? el.tagName : null };
      })()
    `);
    if (focused.success) {
      const f = focused.data as { ok: boolean; tag: string | null };
      if (!f.ok) {
        return err({
          kind: "invalid_state",
          message:
            "No editable element is focused — typed text would be lost. Click the field with browser_click first, or use browser_fill with a selector.",
          details: { activeElement: f.tag },
        });
      }
    }
    const r = await client.session().call("Input.insertText", { text: args.text });
    if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
    return ok({ text: `Typed: "${args.text}"` });
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
    "Special key names: Enter, Tab, Backspace, Escape, Delete, ArrowLeft, ArrowUp, ArrowRight, ArrowDown, Home, End, PageUp, PageDown.",
    "Use Space as ' ' (a single space character).",
    "Modifiers: 1=Alt, 2=Ctrl, 4=Meta(Cmd), 8=Shift. Combine with bitwise OR: Ctrl+Shift = 2|8 = 10.",
  ],
  parameters: PressKeyArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const k = args.key;
    const code = virtualKeyCode(k);
    const modifiers = args.modifiers ?? 0;
    const isChar = k.length === 1;
    const downParams: Record<string, unknown> = {
      type: "keyDown",
      key: k,
      code: k,
      modifiers,
      ...(code ? { windowsVirtualKeyCode: code, nativeVirtualKeyCode: code } : {}),
      ...(isChar ? { text: k, unmodifiedText: k } : {}),
    };
    const down = await client.session().call("Input.dispatchKeyEvent", downParams);
    if (!down.success) return err({ kind: "cdp_error", message: down.error.message });
    // For a printable character with no command modifier (Ctrl/Meta/Alt = 1|2|4),
    // emit a `char` event so the page receives keypress/textInput and the
    // character is actually inserted. Shift (8) is allowed (capitals/symbols).
    const hasCommandModifier = (modifiers & (1 | 2 | 4)) !== 0;
    if (isChar && !hasCommandModifier) {
      const charEv = await client.session().call("Input.dispatchKeyEvent", { type: "char", text: k, key: k });
      if (!charEv.success) return err({ kind: "cdp_error", message: charEv.error.message });
    }
    const up = await client.session().call("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, modifiers });
    if (!up.success) return err({ kind: "cdp_error", message: up.error.message });
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
    "PREFER `ref` from browser_snapshot over a CSS selector — survives re-renders.",
    "Dispatches a synthetic DOM KeyboardEvent — for React/Vue synthetic event listeners. Does NOT insert text (use browser_type or browser_press_key for actual typing).",
    "Try browser_press_key first; only use browser_dispatch_key when the page ignores raw CDP key events.",
    "eventType defaults to 'keydown'.",
  ],
  parameters: DispatchKeyArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const eventType = args.eventType ?? "keydown";
    const target = args.ref ?? args.selector ?? "";
    // Ref path: dispatch on the single resolved node. Selector path: dispatch on
    // all matches (preserves the original multi-match behavior).
    if (args.ref !== undefined) {
      const objectId = await resolveRefToObjectId(client, args.ref);
      if (!objectId.success) return objectId;
      const r = await client.session().call("Runtime.callFunctionOn", {
        objectId: objectId.data,
        functionDeclaration: `function (type, key) { this.dispatchEvent(new KeyboardEvent(type, { key, bubbles: true, cancelable: true })); return 1; }`,
        arguments: [{ value: eventType }, { value: args.key }],
        returnByValue: true,
      });
      if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
      return ok({
        text: `Dispatched ${eventType}('${args.key}') on ${target}`,
        details: { matched: 1, ref: args.ref },
      });
    }
    if (args.selector === undefined) {
      return err({ kind: "invalid_state", message: "Provide either `ref` or `selector`." });
    }
    const expr = safeJs`
      (() => {
        const els = document.querySelectorAll(${args.selector});
        if (els.length === 0) return 0;
        for (const el of els) {
          el.dispatchEvent(new KeyboardEvent(${eventType}, { key: ${args.key}, bubbles: true, cancelable: true }));
        }
        return els.length;
      })()
    `;
    const r = await client.evaluateJs(expr);
    if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
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
