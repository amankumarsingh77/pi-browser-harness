import { Type } from "typebox";
import type { BrowserClient } from "../client";
import { safeJs } from "../util/js-template";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { cdpCall } from "./cdp-call";
import { fillBody } from "./fill-engine";
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
  opts: {
    ref?: string | undefined;
    selector?: string | undefined;
    fnBody: string;
    arg: unknown;
    notFound?: unknown;
  },
): Promise<Result<unknown, ToolErr>> => {
  if (opts.ref !== undefined) {
    const objectId = await resolveRefToObjectId(client, opts.ref);
    if (!objectId.success) return objectId;
    const r = await cdpCall(client, "Runtime.callFunctionOn", {
      objectId: objectId.data,
      functionDeclaration: `function (arg) { ${opts.fnBody} }`,
      arguments: [{ value: opts.arg }],
      returnByValue: true,
    });
    if (!r.success) return r;
    if (r.data.exceptionDetails !== undefined) {
      return err({
        kind: "cdp_error",
        message: `page function threw: ${r.data.exceptionDetails.text}`,
        details: { ref: opts.ref },
      });
    }
    return ok(r.data.result.value);
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
      if (!el) return ${opts.notFound ?? { status: "not_found" }};
      const __arg = ${opts.arg};
      return (function (arg) {`;
  const expr = `${prelude} ${opts.fnBody} }).call(el, __arg); })()`;
  const r = await client.evaluateJs(expr);
  if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
  return ok(r.data);
};

const FILL_BODY = `const value = arg;\n${fillBody({ rejectSelect: true, focusFirst: false })}`;

const NOT_FOUND: PageResult = { ok: false, reason: "not_found" };

export const fillTool = defineBrowserTool({
  name: "browser_fill",
  label: "Browser Fill",
  description:
    "Fill a form field (input/textarea/contenteditable), or tick a checkbox/radio by passing 'true'/'false'. PREFERRED: pass `ref` (e.g. 'e7') from browser_snapshot — survives re-renders. Fallback: a CSS `selector`. Writes through the native value setter and fires bubbling 'input'/'change' events, so React/Vue/Angular controlled components and rich-text editors update correctly — unlike browser_type. Refuses a disabled field rather than writing a value the page will ignore. Returns the field's value after writing, plus a compact diff of page changes.",
  promptSnippet: "Fill a form field by ref (preferred) or selector (works with React/Vue controlled inputs)",
  promptGuidelines: [
    "PREFER `ref` from browser_snapshot (the '[eN]' handle) over a guessed CSS selector — refs survive re-renders and don't require you to invent a selector.",
    "Pass the desired value; no browser_click is needed first.",
    "For a checkbox or radio pass 'true' or 'false' — it toggles `checked`, not the submit value. browser_set_checked does the same thing with a boolean.",
    "A disabled field is refused: the error says so, rather than reporting a write the page never accepted.",
    "A 'ref is stale' error means the page changed — re-run browser_snapshot to get fresh refs.",
    "Use browser_type instead only for keystroke-sensitive widgets (autocomplete, masked/segmented inputs).",
    "Fill sets the value but does not focus or submit. To submit a tag/autocomplete input, follow with browser_dispatch_key({ ref, key: 'Enter' }) — not browser_press_key, which targets the focused element and may miss this field.",
    "For a custom (div-based) dropdown, browser_fill won't validate against its option list — open it, run browser_snapshot, then browser_click the option's ref.",
    "The result reports the field's value after writing and an appended page-changes diff — confirm both match what you intended before moving on.",
  ],
  parameters: FillArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await runOnElement(client, {
      ref: args.ref,
      selector: args.selector,
      fnBody: FILL_BODY,
      arg: args.value,
      notFound: NOT_FOUND,
    });
    if (!r.success) return r;
    const res = isPageResult(r.data) ? r.data : undefined;
    const target = args.ref ?? args.selector ?? "";
    if (res === undefined || res.reason === "not_found") {
      return err({
        kind: "invalid_state",
        message: `No element matched: ${target}`,
        details: { ref: args.ref, selector: args.selector },
      });
    }
    if (!res.ok) {
      const details = { ref: args.ref, selector: args.selector, ...(res.tag !== undefined ? { tag: res.tag } : {}) };
      if (res.kind === "select") {
        return err({
          kind: "invalid_state",
          message: `Element <select> is not fillable (not an input, textarea, or contenteditable): ${target}. For <select> use browser_select_option.`,
          details,
        });
      }
      return err({
        kind: "invalid_state",
        message: `Could not fill ${target}: ${res.reason ?? "unknown reason"}`,
        details,
      });
    }
    const shown = res.value !== undefined ? JSON.stringify(res.value) : `checked=${res.checked === true}`;
    const diff = await interactiveDiff(client);
    return ok({
      text: `Filled ${target} = ${shown}${diff}`,
      details: {
        ref: args.ref,
        selector: args.selector,
        value: args.value,
        verified: res.value ?? res.checked,
        ...(res.tag !== undefined ? { tag: res.tag } : {}),
        ...(res.kind !== undefined ? { kind: res.kind } : {}),
      },
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

const isFocusResult = (v: unknown): v is FocusResult => {
  if (typeof v !== "object" || v === null || !("status" in v)) return false;
  if (v.status === "not_found") return true;
  if (v.status === "ok" || v.status === "not_focusable") return "tag" in v && typeof v.tag === "string";
  return false;
};

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
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await runOnElement(client, { ref: args.ref, selector: args.selector, fnBody: FOCUS_FN, arg: "" });
    if (!r.success) return r;
    const res = isFocusResult(r.data) ? r.data : undefined;
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

const isSelectOption = (v: unknown): v is { value: string; label: string } =>
  typeof v === "object" && v !== null
  && "value" in v && typeof v.value === "string"
  && "label" in v && typeof v.label === "string";

const isSelectResult = (v: unknown): v is SelectResult => {
  if (typeof v !== "object" || v === null || !("status" in v)) return false;
  if (v.status === "not_found") return true;
  if (v.status === "not_select") return "tag" in v && typeof v.tag === "string";
  if (v.status === "ok") {
    return "value" in v && typeof v.value === "string" && "label" in v && typeof v.label === "string";
  }
  if (v.status === "no_match") {
    return "options" in v && Array.isArray(v.options) && v.options.every(isSelectOption);
  }
  return false;
};

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
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    if (args.value === undefined && args.label === undefined && args.index === undefined) {
      return err({ kind: "invalid_state", message: "Provide one of value, label, or index." });
    }
    // null sentinels distinguish "not provided" from a real empty-string match.
    const arg = { wv: args.value ?? null, wl: args.label ?? null, wi: args.index ?? null };
    const r = await runOnElement(client, { ref: args.ref, selector: args.selector, fnBody: SELECT_FN, arg });
    if (!r.success) return r;
    const res = isSelectResult(r.data) ? r.data : undefined;
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

export type PageResult = {
  readonly ok: boolean;
  readonly reason?: string;
  readonly kind?: string;
  readonly value?: unknown;
  readonly text?: string;
  readonly checked?: boolean;
  readonly changed?: boolean;
  readonly tag?: string;
  readonly options?: ReadonlyArray<{ value: string; text: string }>;
};

const isOption = (v: unknown): v is { readonly value: string; readonly text: string } =>
  typeof v === "object" && v !== null
  && "value" in v && typeof v.value === "string"
  && "text" in v && typeof v.text === "string";

const isPageResult = (v: unknown): v is PageResult => {
  if (typeof v !== "object" || v === null) return false;
  if (!("ok" in v) || typeof v.ok !== "boolean") return false;
  if ("reason" in v && typeof v.reason !== "string") return false;
  if ("kind" in v && typeof v.kind !== "string") return false;
  if ("text" in v && typeof v.text !== "string") return false;
  if ("checked" in v && typeof v.checked !== "boolean") return false;
  if ("changed" in v && typeof v.changed !== "boolean") return false;
  if ("tag" in v && typeof v.tag !== "string") return false;
  if ("options" in v && !(Array.isArray(v.options) && v.options.every(isOption))) return false;
  return true;
};

export const resolveAndCall = async (
  client: BrowserClient,
  ref: string,
  functionDeclaration: string,
  args: ReadonlyArray<unknown>,
): Promise<Result<PageResult, ToolErr>> => {
  const objectId = await resolveRefToObjectId(client, ref);
  if (!objectId.success) return objectId;
  const handle = objectId.data;
  try {
    const called = await client.session().call("Runtime.callFunctionOn", {
      objectId: handle,
      functionDeclaration,
      arguments: args.map((v) => ({ value: v })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (!called.success) return err({ kind: "cdp_error", message: called.error.message, details: { ref } });
    if (called.data.exceptionDetails !== undefined) {
      return err({ kind: "cdp_error", message: `page function threw: ${JSON.stringify(called.data.exceptionDetails)}`, details: { ref } });
    }
    const value = called.data.result.value;
    if (!isPageResult(value)) {
      return err({ kind: "internal", message: "page function returned no result object", details: { ref } });
    }
    return ok(value);
  } finally {
    await client.session().call("Runtime.releaseObject", { objectId: handle });
  }
};

export const detailsOf = (ref: string, res: PageResult, extra?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const { ok: _ok, ...rest } = res;
  return { ref, ...rest, ...(extra ?? {}) };
};

const CHECK_FN = `
function(checked) {
  const el = this;
  const tag = (el.tagName || "").toLowerCase();
  const type = (el.type || "").toLowerCase();
  if (tag !== "input" || (type !== "checkbox" && type !== "radio")) return { ok: false, reason: "ref is not a checkbox or radio" };
  if (el.disabled) return { ok: false, reason: "element is disabled" };
  const want = checked === true;
  let changed = false;
  if (el.checked !== want) {
    try { el.click(); } catch (e) {}
    if (el.checked !== want) { el.checked = want; el.dispatchEvent(new Event("change", { bubbles: true })); }
    changed = true;
  }
  return { ok: true, checked: el.checked, changed: changed };
}`;

const SetCheckedArgs = Type.Object({
  ref: Type.String({ description: "Stable element ref of a checkbox or radio from browser_snapshot (e.g. 'e7')." }),
  checked: Type.Boolean({ description: "Desired checked state." }),
});

export const setCheckedTool = defineBrowserTool({
  name: "browser_set_checked",
  label: "Browser Set Checked",
  description:
    "Set a checkbox or radio to a desired checked state by ref. Only acts if the current state differs, fires change, and reports the final state. Get the ref from browser_snapshot's [eN].",
  promptSnippet: "Set a checkbox/radio checked state by ref",
  promptGuidelines: [
    "checked:true ticks the box, checked:false unticks it. Idempotent — no-op if already in the desired state.",
    "For radios, set checked:true on the option you want; the group deselects the others.",
  ],
  parameters: SetCheckedArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await resolveAndCall(client, args.ref, CHECK_FN, [args.checked]);
    if (!r.success) return r;
    const res = r.data;
    if (!res.ok) {
      return err({ kind: "invalid_state", message: `Could not set checked on ref ${args.ref}: ${res.reason ?? "unknown reason"}`, details: detailsOf(args.ref, res) });
    }
    return ok({
      text: `Set ref ${args.ref} checked=${res.checked}` + (res.changed === false ? " (already)" : ""),
      details: detailsOf(args.ref, res),
    });
  },
});
