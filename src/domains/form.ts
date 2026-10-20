import { Type } from "typebox";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type JsonObject, type ToolErr, type ToolOk } from "../util/tool";
import { detailsOf, type ElementOutcome, isPageResult, resolveAndCall, runOnElement } from "./element-call";
import { fillField, type FillOptions } from "./page/fill.page";
import { type FocusResult, focusElement, type SelectOption, type SelectResult, type SelectWanted, selectOption, setChecked } from "./page/form.page";
import { elementFunctionSource } from "./page/inject";
import { interactiveDiff } from "./ref-resolve";

type Target = { readonly ref?: string | undefined; readonly selector?: string | undefined };

const targetLabel = (t: Target): string => t.ref ?? t.selector ?? "";

// Only the locator the caller actually passed goes into details; an undefined key would not survive pi's JSON store.
const targetDetails = (t: Target): JsonObject => ({
  ...(t.ref !== undefined ? { ref: t.ref } : {}),
  ...(t.selector !== undefined ? { selector: t.selector } : {}),
});

const noMatch = (t: Target): ToolErr => ({
  kind: "invalid_state",
  message: `No element matched: ${targetLabel(t)}`,
  details: { ref: t.ref, selector: t.selector },
});

// A page function that returned something the guard does not recognise is a harness bug, not a missing element.
const badShape = (t: Target, what: string): ToolErr => ({
  kind: "internal",
  message: `unexpected page result shape from ${what}`,
  details: { ref: t.ref, selector: t.selector },
});

// Narrows an element outcome to the page's typed result, or returns the error to surface.
const narrow = <T>(
  outcome: ElementOutcome,
  t: Target,
  what: string,
  guard: (v: unknown) => v is T,
): Result<T, ToolErr> => {
  if (!outcome.found) return err(noMatch(t));
  if (!guard(outcome.value)) return err(badShape(t, what));
  return ok(outcome.value);
};

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

const FILL_FN = elementFunctionSource(fillField);
const FILL_OPTIONS: FillOptions = { rejectSelect: true, focusFirst: false };

export const fillTool = defineBrowserTool({
  name: "browser_fill",
  label: "Browser Fill",
  description:
    "Fill a form field (input/textarea/contenteditable), or tick a checkbox/radio by passing 'true'/'false'. PREFERRED: pass `ref` (e.g. 'e7') from browser_snapshot — survives re-renders. Fallback: a CSS `selector`. Writes through the native value setter and fires bubbling 'input'/'change' events, so React/Vue/Angular controlled components and rich-text editors update correctly — unlike browser_type. Refuses a disabled field rather than writing a value the page will ignore. Returns the field's value after writing, plus a compact diff of page changes.",
  promptSnippet: "Fill a form field by ref (preferred) or selector (works with React/Vue controlled inputs)",
  promptGuidelines: [
    "Pass the desired value; no browser_click is needed first.",
    "For a checkbox or radio pass 'true' or 'false' — it toggles `checked`, not the submit value. browser_set_checked does the same thing with a boolean.",
    "Use browser_type instead only for keystroke-sensitive widgets (autocomplete, masked/segmented inputs).",
    "Fill sets the value but does not focus or submit. To submit a tag/autocomplete input, follow with browser_dispatch_key({ ref, key: 'Enter' }) — not browser_press_key, which targets the focused element and may miss this field.",
    "For a custom (div-based) dropdown, browser_fill won't validate against its option list — open it, run browser_snapshot, then browser_click the option's ref.",
    "Confirm the field value browser_fill returns matches what you intended.",
  ],
  parameters: FillArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await runOnElement(client, { ref: args.ref, selector: args.selector, functionDeclaration: FILL_FN, args: [args.value, FILL_OPTIONS] });
    if (!r.success) return r;
    const narrowed = narrow(r.data, args, "browser_fill", isPageResult);
    if (!narrowed.success) return narrowed;
    const res = narrowed.data;
    const target = targetLabel(args);
    if (!res.ok) {
      const details = { ref: args.ref, selector: args.selector, ...(res.tag !== undefined ? { tag: res.tag } : {}) };
      if (res.code === "select_rejected") {
        return err({
          kind: "invalid_state",
          message: `Element <select> is not fillable (not an input, textarea, or contenteditable): ${target}. For <select> use browser_select_option.`,
          details,
        });
      }
      return err({ kind: "invalid_state", message: `Could not fill ${target}: ${res.reason}`, details });
    }
    const verified = "checked" in res ? res.checked : res.value;
    const shown = "checked" in res ? `checked=${res.checked}` : JSON.stringify(res.value);
    const diff = await interactiveDiff(client);
    return ok({
      text: `Filled ${target} = ${shown}${diff}`,
      details: { ...targetDetails(args), value: args.value, verified, tag: res.tag, kind: res.kind },
    });
  },
});

const FocusArgs = Type.Object({
  ref: Type.Optional(
    Type.String({ description: "Stable element ref from browser_snapshot (e.g. 'e7'). PREFERRED over selector." }),
  ),
  selector: Type.Optional(Type.String({ description: "CSS selector of the element to focus (fallback when no ref)" })),
});

const isFocusResult = (v: unknown): v is FocusResult => {
  if (typeof v !== "object" || v === null || !("status" in v)) return false;
  if (v.status === "ok" || v.status === "not_focusable") return "tag" in v && typeof v.tag === "string";
  return false;
};

const FOCUS_FN = elementFunctionSource(focusElement);

export const focusTool = defineBrowserTool({
  name: "browser_focus",
  label: "Browser Focus",
  description:
    "Focus an element via the DOM .focus() method — deterministic, no coordinate accuracy needed. PREFERRED: pass `ref` from browser_snapshot; fallback: a CSS `selector`. Use before browser_type when a click might miss the field.",
  promptSnippet: "Focus an element by ref (preferred) or selector",
  promptGuidelines: [
    "For simply setting a value, prefer browser_fill (it doesn't need a separate focus step).",
  ],
  parameters: FocusArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await runOnElement(client, { ref: args.ref, selector: args.selector, functionDeclaration: FOCUS_FN, args: [] });
    if (!r.success) return r;
    const narrowed = narrow(r.data, args, "browser_focus", isFocusResult);
    if (!narrowed.success) return narrowed;
    const res = narrowed.data;
    const target = targetLabel(args);
    if (res.status === "not_focusable") {
      return err({ kind: "invalid_state", message: `Element <${res.tag.toLowerCase()}> could not be focused: ${target}`, details: { ref: args.ref, selector: args.selector, tag: res.tag } });
    }
    return ok({ text: `Focused ${target}`, details: { ...targetDetails(args), tag: res.tag } });
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

const isSelectOption = (v: unknown): v is SelectOption =>
  typeof v === "object" && v !== null
  && "value" in v && typeof v.value === "string"
  && "label" in v && typeof v.label === "string";

const isSelectResult = (v: unknown): v is SelectResult => {
  if (typeof v !== "object" || v === null || !("status" in v)) return false;
  if (v.status === "not_select") return "tag" in v && typeof v.tag === "string";
  if (v.status === "ok") {
    return "value" in v && typeof v.value === "string" && "label" in v && typeof v.label === "string";
  }
  if (v.status === "no_match") {
    return "options" in v && Array.isArray(v.options) && v.options.every(isSelectOption);
  }
  return false;
};

const SELECT_FN = elementFunctionSource(selectOption);

export const selectOptionTool = defineBrowserTool({
  name: "browser_select_option",
  label: "Browser Select Option",
  description:
    "Select an option in a native <select> element by value, visible label, or index. PREFERRED: pass `ref` from browser_snapshot; fallback: a CSS `selector`. Sets the selection and fires bubbling 'input'/'change' events so framework listeners update. On no match, returns the available options.",
  promptSnippet: "Select an option in a native <select> by ref (preferred) or selector",
  promptGuidelines: [
    "Provide exactly one of value, label, or index to choose the option.",
    "For custom (non-native) dropdowns built from divs, click to open then browser_click the option instead.",
  ],
  parameters: SelectOptionArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    if (args.value === undefined && args.label === undefined && args.index === undefined) {
      return err({ kind: "invalid_args", message: "Provide one of value, label, or index." });
    }
    const wanted: SelectWanted = { wv: args.value ?? null, wl: args.label ?? null, wi: args.index ?? null };
    const r = await runOnElement(client, { ref: args.ref, selector: args.selector, functionDeclaration: SELECT_FN, args: [wanted] });
    if (!r.success) return r;
    const narrowed = narrow(r.data, args, "browser_select_option", isSelectResult);
    if (!narrowed.success) return narrowed;
    const res = narrowed.data;
    const target = targetLabel(args);
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
      details: { ...targetDetails(args), value: res.value, label: res.label },
    });
  },
});

const CHECK_FN = elementFunctionSource(setChecked);

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
    "For radios, set checked:true on the option you want; the group deselects the others.",
  ],
  parameters: SetCheckedArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await resolveAndCall(client, args.ref, CHECK_FN, [args.checked]);
    if (!r.success) return r;
    const res = r.data;
    if (!res.ok) {
      return err({ kind: "invalid_state", message: `Could not set checked on ref ${args.ref}: ${res.reason}`, details: detailsOf(args.ref, res) });
    }
    if (!("checked" in res)) {
      return err({ kind: "internal", message: `unexpected page result shape from browser_set_checked (kind ${res.kind})`, details: { ref: args.ref } });
    }
    return ok({
      text: `Set ref ${args.ref} checked=${res.checked}` + (res.changed ? "" : " (already)"),
      details: detailsOf(args.ref, res),
    });
  },
});
