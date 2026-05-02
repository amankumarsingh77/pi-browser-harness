import { Type } from "typebox";
import { safeJs } from "../util/js-template";
import { virtualKeyCode } from "../util/keycodes";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";

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
    const up = await client.session().call("Input.dispatchKeyEvent", { type: "keyUp", key: k, code: k, modifiers });
    if (!up.success) return err({ kind: "cdp_error", message: up.error.message });
    return ok({ text: `Pressed: ${k}${modifiers ? ` (modifiers=${modifiers})` : ""}` });
  },
});

const DispatchKeyArgs = Type.Object({
  selector: Type.String({ description: "CSS selector of the target element" }),
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
    "Dispatch a DOM KeyboardEvent on a specific element via JS injection. Use for React/Vue components that listen to synthetic events more reliably than CDP input.",
  promptSnippet: "Dispatch a DOM KeyboardEvent on a specific element",
  promptGuidelines: [
    "Dispatches a synthetic DOM KeyboardEvent — for React/Vue synthetic event listeners. Does NOT insert text into inputs (use browser_type or browser_press_key for actual typing).",
    "Try browser_press_key first; only use browser_dispatch_key when the page ignores raw CDP key events.",
    "The selector must match exactly one or more elements; zero matches is reported as an error.",
    "eventType defaults to 'keydown'.",
  ],
  parameters: DispatchKeyArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const eventType = args.eventType ?? "keydown";
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
