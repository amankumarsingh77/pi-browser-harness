import { Type } from "typebox";
import type { BrowserClient } from "../client";
import { safeJs } from "../util/js-template";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { interactiveDiff, resolveRefToObjectId } from "./ref-resolve";

const FillArgs = Type.Object({
  ref: Type.Optional(
    Type.String({
      description:
        "Stable element ref from browser_snapshot (e.g. 'e7'). PREFERRED over selector — survives re-renders. When set, selector is ignored.",
    }),
  ),
  selector: Type.Optional(Type.String({ description: "CSS selector of the form field to fill (fallback when no ref)" })),
  value: Type.String({ description: "Value to set in the field" }),
});

/**
 * Run an element-scoped function either against a CSS selector (querySelector +
 * apply) or a ref (resolve to objectId, callFunctionOn with element as `this`).
 * The shared `fnBody` is a function body where `this` is the target element and
 * the single argument is the value — identical logic on both paths. Returns the
 * function's return value (parsed) or a ToolErr.
 *
 * On the ref path a detached node yields a stale-ref error; on the selector path
 * a missing element returns { status: "not_found" } from the function body.
 */
const runOnElement = async (
  client: BrowserClient,
  opts: { ref?: string | undefined; selector?: string | undefined; fnBody: string; arg: unknown },
): Promise<Result<unknown, ToolErr>> => {
  if (opts.ref !== undefined) {
    const objectId = await resolveRefToObjectId(client, opts.ref);
    if (!objectId.success) return objectId;
    const r = await client.session().call("Runtime.callFunctionOn", {
      objectId: objectId.data,
      functionDeclaration: `function (arg) { ${opts.fnBody} }`,
      arguments: [{ value: opts.arg }],
      returnByValue: true,
    });
    if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
    return ok((r.data as { result?: { value?: unknown } }).result?.value);
  }
  if (opts.selector === undefined) {
    return err({ kind: "invalid_state", message: "Provide either `ref` or `selector`." });
  }
  // Selector path: bind the same trusted function body to the matched element
  // via .call(). fnBody is harness-authored (not user input); only the selector
  // and value are interpolated, and those go through safeJs.
  const prelude = safeJs`
    (() => {
      const el = document.querySelector(${opts.selector});
      if (!el) return { status: "not_found" };
      const __arg = ${opts.arg};
      return (function (arg) {`;
  const expr = `${prelude} ${opts.fnBody} }).call(el, __arg); })()`;
  const r = await client.evaluateJs(expr);
  if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
  return ok(r.data);
};

/**
 * Result shape returned by the in-page fill script. Discriminated by `status`
 * so the handler can map page-level outcomes to typed ToolErr kinds.
 */
type FillResult =
  | { status: "ok"; tag: string; kind: string; value: string }
  | { status: "not_found" }
  | { status: "not_fillable"; tag: string };

// Element-scoped fill logic. `this` is the target element, `arg` is the value.
// Write via the native prototype value setter so React's _valueTracker
// registers the change — assigning el.value directly does NOT, which is why
// controlled inputs revert on re-render. Shared verbatim by the ref path
// (callFunctionOn) and the selector path (querySelector + .call).
const FILL_FN = `
  const el = this;
  const tag = el.tagName;
  const proto =
    el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype
    : el instanceof HTMLInputElement ? HTMLInputElement.prototype
    : null;
  if (proto) {
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    const setter = desc && desc.set;
    if (setter) setter.call(el, arg);
    else el.value = arg;
    el.dispatchEvent(new Event("input", { bubbles: true }));
    el.dispatchEvent(new Event("change", { bubbles: true }));
    return { status: "ok", tag, kind: el.type || tag.toLowerCase(), value: el.value };
  }
  if (el.isContentEditable) {
    // Rich-text editors (Slack/Notion/ProseMirror) listen for beforeinput/input.
    el.focus();
    let done = false;
    try {
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); const rng = document.createRange(); rng.selectNodeContents(el); sel.addRange(rng); }
      done = document.execCommand("insertText", false, arg);
    } catch (e) { done = false; }
    if (!done) {
      el.textContent = arg;
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    return { status: "ok", tag, kind: "contenteditable", value: el.textContent || "" };
  }
  return { status: "not_fillable", tag };
`;

export const fillTool = defineBrowserTool({
  name: "browser_fill",
  label: "Browser Fill",
  description:
    "Fill a form field (input/textarea/contenteditable). PREFERRED: pass `ref` (e.g. 'e7') from browser_snapshot — survives re-renders. Fallback: a CSS `selector`. Writes through the native value setter and fires bubbling 'input'/'change' events, so React/Vue/Angular controlled components and rich-text editors update correctly — unlike browser_type. Returns the field's value after writing, plus a compact diff of page changes.",
  promptSnippet: "Fill a form field by ref (preferred) or selector (works with React/Vue controlled inputs)",
  promptGuidelines: [
    "PREFER `ref` from browser_snapshot (the '[eN]' handle) over a guessed CSS selector — refs survive re-renders and don't require you to invent a selector.",
    "Pass the desired value; no browser_click is needed first.",
    "A 'ref is stale' error means the page changed — re-run browser_snapshot to get fresh refs.",
    "Use browser_type instead only for keystroke-sensitive widgets (autocomplete, masked/segmented inputs).",
    "The result reports the field's value after writing and an appended page-changes diff — confirm both match what you intended before moving on.",
  ],
  parameters: FillArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await runOnElement(client, { ref: args.ref, selector: args.selector, fnBody: FILL_FN, arg: args.value });
    if (!r.success) return r;
    const res = r.data as FillResult | undefined;
    const target = args.ref ?? args.selector ?? "";
    if (res === undefined || res.status === "not_found") {
      return err({
        kind: "invalid_state",
        message: `No element matched: ${target}`,
        details: { ref: args.ref, selector: args.selector },
      });
    }
    if (res.status === "not_fillable") {
      return err({
        kind: "invalid_state",
        message: `Element <${res.tag.toLowerCase()}> is not fillable (not an input, textarea, or contenteditable): ${target}. For <select> use browser_select_option.`,
        details: { ref: args.ref, selector: args.selector, tag: res.tag },
      });
    }
    const diff = await interactiveDiff(client);
    return ok({
      text: `Filled ${target} = ${JSON.stringify(res.value)}${diff}`,
      details: { ref: args.ref, selector: args.selector, value: args.value, verified: res.value, tag: res.tag, kind: res.kind },
    });
  },
});

const FocusArgs = Type.Object({
  ref: Type.Optional(
    Type.String({ description: "Stable element ref from browser_snapshot (e.g. 'e7'). PREFERRED over selector." }),
  ),
  selector: Type.Optional(Type.String({ description: "CSS selector of the element to focus (fallback when no ref)" })),
});

type FocusResult = { status: "ok"; tag: string } | { status: "not_found" } | { status: "not_focusable"; tag: string };

const FOCUS_FN = `
  const el = this;
  if (typeof el.focus !== "function") return { status: "not_focusable", tag: el.tagName };
  el.focus();
  return document.activeElement === el ? { status: "ok", tag: el.tagName } : { status: "not_focusable", tag: el.tagName };
`;

export const focusTool = defineBrowserTool({
  name: "browser_focus",
  label: "Browser Focus",
  description:
    "Focus an element via the DOM .focus() method — deterministic, no coordinate accuracy needed. PREFERRED: pass `ref` from browser_snapshot; fallback: a CSS `selector`. Use before browser_type when a click might miss the field.",
  promptSnippet: "Focus an element by ref (preferred) or selector",
  promptGuidelines: [
    "PREFER `ref` from browser_snapshot over a CSS selector — survives re-renders.",
    "Use before browser_type to guarantee the right field is focused without relying on click coordinates.",
    "For simply setting a value, prefer browser_fill (it doesn't need a separate focus step).",
  ],
  parameters: FocusArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await runOnElement(client, { ref: args.ref, selector: args.selector, fnBody: FOCUS_FN, arg: "" });
    if (!r.success) return r;
    const res = r.data as FocusResult | undefined;
    const target = args.ref ?? args.selector ?? "";
    if (res === undefined || res.status === "not_found") {
      return err({ kind: "invalid_state", message: `No element matched: ${target}`, details: { ref: args.ref, selector: args.selector } });
    }
    if (res.status === "not_focusable") {
      return err({ kind: "invalid_state", message: `Element <${res.tag.toLowerCase()}> could not be focused: ${target}`, details: { ref: args.ref, selector: args.selector, tag: res.tag } });
    }
    return ok({ text: `Focused ${target}`, details: { ref: args.ref, selector: args.selector, tag: res.tag } });
  },
});

const SelectOptionArgs = Type.Object({
  ref: Type.Optional(
    Type.String({ description: "Stable element ref of the <select> from browser_snapshot. PREFERRED over selector." }),
  ),
  selector: Type.Optional(Type.String({ description: "CSS selector of the <select> element (fallback when no ref)" })),
  value: Type.Optional(Type.String({ description: "Option value attribute to select" })),
  label: Type.Optional(Type.String({ description: "Visible option text to select (exact match)" })),
  index: Type.Optional(Type.Integer({ minimum: 0, description: "Zero-based option index to select" })),
});

type SelectResult =
  | { status: "ok"; value: string; label: string }
  | { status: "not_found" }
  | { status: "not_select"; tag: string }
  | { status: "no_match"; options: ReadonlyArray<{ value: string; label: string }> };

// `this` is the <select>; `arg` is { wv, wl, wi } (null = not provided).
const SELECT_FN = `
  const el = this;
  if (el.tagName !== "SELECT") return { status: "not_select", tag: el.tagName };
  const opts = Array.from(el.options);
  const wv = arg.wv, wl = arg.wl, wi = arg.wi;
  let opt = null;
  if (wi !== null) opt = opts[wi] || null;
  else if (wv !== null) opt = opts.find(o => o.value === wv) || null;
  else if (wl !== null) opt = opts.find(o => o.text === wl) || null;
  if (!opt) return { status: "no_match", options: opts.map(o => ({ value: o.value, label: o.text })) };
  el.value = opt.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { status: "ok", value: opt.value, label: opt.text };
`;

export const selectOptionTool = defineBrowserTool({
  name: "browser_select_option",
  label: "Browser Select Option",
  description:
    "Select an option in a native <select> element by value, visible label, or index. PREFERRED: pass `ref` from browser_snapshot; fallback: a CSS `selector`. Sets the selection and fires bubbling 'input'/'change' events so framework listeners update. On no match, returns the available options.",
  promptSnippet: "Select an option in a native <select> by ref (preferred) or selector",
  promptGuidelines: [
    "PREFER `ref` from browser_snapshot over a CSS selector — survives re-renders.",
    "Provide exactly one of value, label, or index to choose the option.",
    "For custom (non-native) dropdowns built from divs, click to open then browser_click the option instead.",
    "If no option matches, the error details list the available options so you can retry.",
  ],
  parameters: SelectOptionArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    if (args.value === undefined && args.label === undefined && args.index === undefined) {
      return err({ kind: "invalid_state", message: "Provide one of value, label, or index." });
    }
    // null sentinels distinguish "not provided" from a real empty-string match.
    const arg = { wv: args.value ?? null, wl: args.label ?? null, wi: args.index ?? null };
    const r = await runOnElement(client, { ref: args.ref, selector: args.selector, fnBody: SELECT_FN, arg });
    if (!r.success) return r;
    const res = r.data as SelectResult | undefined;
    const target = args.ref ?? args.selector ?? "";
    if (res === undefined || res.status === "not_found") {
      return err({ kind: "invalid_state", message: `No element matched: ${target}`, details: { ref: args.ref, selector: args.selector } });
    }
    if (res.status === "not_select") {
      return err({ kind: "invalid_state", message: `Element <${res.tag.toLowerCase()}> is not a <select>: ${target}`, details: { ref: args.ref, selector: args.selector, tag: res.tag } });
    }
    if (res.status === "no_match") {
      return err({
        kind: "invalid_state",
        message: `No matching option in ${target}. Available: ${res.options.map((o) => o.label).join(", ")}`,
        details: { ref: args.ref, selector: args.selector, options: res.options },
      });
    }
    const diff = await interactiveDiff(client);
    return ok({
      text: `Selected "${res.label}" (value=${JSON.stringify(res.value)}) in ${target}${diff}`,
      details: { ref: args.ref, selector: args.selector, value: res.value, label: res.label },
    });
  },
});
