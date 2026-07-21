import { Type } from "typebox";
import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";

// ── Page-side functions ──────────────────────────────────────────────────────
// These run inside the page via Runtime.callFunctionOn with `this` bound to the
// resolved element. They are NOT string-interpolated with user data — the value
// is passed as a structured `arguments` entry, so safeJs is unnecessary here.

/**
 * Universal field setter. Auto-detects the element type and applies the right
 * strategy, then reads the resulting value back so the caller can confirm.
 *
 * The <input>/<textarea> branch uses the "native setter" trick: React (and
 * other frameworks) overload the element's `value` setter to track state, so a
 * plain `el.value = x` updates the DOM but not the framework. Calling the
 * prototype's original setter and then dispatching a bubbling `input` event is
 * what makes React's onChange fire.
 */
const FILL_FN = `
function(value) {
  const el = this;
  if (!el || el.nodeType !== 1) return { ok: false, reason: "ref does not point to an element" };
  if (el.disabled) return { ok: false, reason: "element is disabled" };
  const tag = (el.tagName || "").toLowerCase();
  const type = (el.type || "").toLowerCase();
  try { el.focus(); } catch (e) {}
  const fire = function(t) { el.dispatchEvent(new Event(t, { bubbles: true })); };

  if (tag === "select") {
    const want = String(value);
    let matched = null;
    for (let i = 0; i < el.options.length; i++) {
      const o = el.options[i];
      if (o.value === want || o.label === want || o.text === want) { matched = o; break; }
    }
    if (!matched) {
      const opts = [];
      for (let i = 0; i < el.options.length; i++) opts.push({ value: el.options[i].value, text: el.options[i].text });
      return { ok: false, reason: "no matching option", kind: "select", options: opts };
    }
    el.value = matched.value;
    fire("input"); fire("change");
    return { ok: true, kind: "select", value: el.value, text: matched.text };
  }

  if (tag === "input" && (type === "checkbox" || type === "radio")) {
    const want = value === true || value === "true" || value === "on" || value === 1;
    if (el.checked !== want) {
      try { el.click(); } catch (e) {}
      if (el.checked !== want) { el.checked = want; fire("input"); fire("change"); }
    }
    return { ok: true, kind: type, checked: el.checked };
  }

  if (el.isContentEditable) {
    el.textContent = String(value);
    fire("input"); fire("change");
    return { ok: true, kind: "contenteditable", value: el.textContent };
  }

  if (tag === "input" || tag === "textarea") {
    const proto = tag === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, String(value));
    else el.value = String(value);
    fire("input"); fire("change");
    return { ok: true, kind: tag, value: el.value };
  }

  return { ok: false, reason: "element is not a fillable field (tag=" + tag + ")" };
}`;

/** Specialized <select> setter — matches by value first, then by label/text. */
const SELECT_FN = `
function(value, label) {
  const el = this;
  if (!el || (el.tagName || "").toLowerCase() !== "select") return { ok: false, reason: "ref is not a <select> element" };
  if (el.disabled) return { ok: false, reason: "select is disabled" };
  let matched = null;
  for (let i = 0; i < el.options.length; i++) {
    const o = el.options[i];
    if (value != null && o.value === String(value)) { matched = o; break; }
    if (label != null && (o.text === String(label) || o.label === String(label))) { matched = o; break; }
  }
  if (!matched) {
    const opts = [];
    for (let i = 0; i < el.options.length; i++) opts.push({ value: el.options[i].value, text: el.options[i].text });
    return { ok: false, reason: "no matching option", options: opts };
  }
  try { el.focus(); } catch (e) {}
  el.value = matched.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { ok: true, value: el.value, text: matched.text };
}`;

/** Specialized checkbox/radio setter — only acts when the state differs. */
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

// ── Resolver ─────────────────────────────────────────────────────────────────

/** Shape returned by the page-side functions above. */
type PageResult = {
  readonly ok: boolean;
  readonly reason?: string;
  readonly kind?: string;
  readonly value?: unknown;
  readonly text?: string;
  readonly checked?: boolean;
  readonly changed?: boolean;
  readonly options?: ReadonlyArray<{ value: string; text: string }>;
};

/**
 * Resolve a ref (CDP backendDOMNodeId) to a live JS handle and invoke a
 * page-side function on it. DOM + Runtime are enabled on every session
 * (see cdp/session.ts enableDomains), so no extra setup is required.
 */
const resolveAndCall = async (
  client: BrowserClient,
  ref: number,
  functionDeclaration: string,
  args: ReadonlyArray<unknown>,
): Promise<Result<PageResult, ToolErr>> => {
  const session = client.session();

  const resolved = await session.call("DOM.resolveNode", { backendNodeId: ref });
  if (!resolved.success) {
    return err({
      kind: "invalid_state",
      message: `ref ${ref} could not be resolved — the page may have changed. Re-run browser_snapshot to get fresh refs.`,
      details: { ref },
    });
  }
  const objectId = (resolved.data as { object?: { objectId?: string } }).object?.objectId;
  if (objectId === undefined) {
    return err({
      kind: "invalid_state",
      message: `ref ${ref} resolved to no JS object — re-run browser_snapshot to get fresh refs.`,
      details: { ref },
    });
  }

  try {
    const called = await session.call("Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((v) => ({ value: v })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (!called.success) return err({ kind: "cdp_error", message: called.error.message, details: { ref } });
    const data = called.data as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (data.exceptionDetails !== undefined) {
      return err({ kind: "cdp_error", message: `page function threw: ${JSON.stringify(data.exceptionDetails)}`, details: { ref } });
    }
    const value = data.result?.value;
    if (typeof value !== "object" || value === null) {
      return err({ kind: "internal", message: "page function returned no result object", details: { ref } });
    }
    return ok(value as PageResult);
  } finally {
    // Best-effort: release the remote handle so it can be GC'd. Failure is
    // harmless (the page may have navigated), so we ignore the result.
    await session.call("Runtime.releaseObject", { objectId });
  }
};

/** Drop the `ok` flag before stashing a page result in tool `details` — the
 *  tool-result envelope reserves `ok` for its own success discriminant. */
const detailsOf = (ref: number, res: PageResult, extra?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const { ok: _ok, ...rest } = res;
  return { ref, ...rest, ...(extra ?? {}) };
};

// ── Tools ────────────────────────────────────────────────────────────────────

const FieldValue = Type.Union([Type.String(), Type.Boolean()], {
  description: "Value to set. String for text inputs / textareas / selects / contenteditable; boolean for checkboxes & radios.",
});

const FillArgs = Type.Object({
  ref: Type.Integer({ description: "Element ref from browser_snapshot ([ref=N])." }),
  value: FieldValue,
});

export const fillTool = defineBrowserTool({
  name: "browser_fill",
  label: "Browser Fill",
  description:
    "Fill a single form field by ref. Auto-detects input/textarea/select/checkbox/radio/contenteditable, clears then sets the value, fires input+change events (drives React/Vue controlled inputs correctly), and reads the value back to confirm. Get the ref from browser_snapshot's [ref=N].",
  promptSnippet: "Fill a form field by ref (text, select, checkbox) — React-safe, self-confirming",
  promptGuidelines: [
    "Get the ref from browser_snapshot's [ref=N] for the target field. No click-to-focus needed.",
    "value is a string for text fields/selects/contenteditable, or a boolean for checkboxes/radios.",
    "The result reports the value the field actually holds after filling — check it matches what you intended.",
    "For autocomplete/typeahead that needs real keystrokes, click the field's @(x,y) then use browser_type instead.",
    "If a ref no longer resolves, re-run browser_snapshot to get fresh refs.",
  ],
  parameters: FillArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await resolveAndCall(client, args.ref, FILL_FN, [args.value]);
    if (!r.success) return r;
    const res = r.data;
    if (!res.ok) {
      return err({ kind: "invalid_state", message: `Could not fill ref ${args.ref}: ${res.reason ?? "unknown reason"}`, details: detailsOf(args.ref, res) });
    }
    const wanted = typeof args.value === "boolean" ? undefined : String(args.value);
    const got = res.value !== undefined ? String(res.value) : undefined;
    const mismatch = wanted !== undefined && got !== undefined && got !== wanted;
    let text: string;
    if (mismatch) {
      text = `Filled ref ${args.ref}, but it now reads ${JSON.stringify(got)} (wanted ${JSON.stringify(wanted)})`;
    } else if (got !== undefined) {
      text = `Filled ref ${args.ref} = ${JSON.stringify(got)}`;
    } else if (res.checked !== undefined) {
      text = `Filled ref ${args.ref} (checked=${res.checked})`;
    } else {
      text = `Filled ref ${args.ref}`;
    }
    return ok({ text, details: detailsOf(args.ref, res, { mismatch }) });
  },
});

const FillFormArgs = Type.Object({
  fields: Type.Array(
    Type.Object({
      ref: Type.Integer({ description: "Element ref from browser_snapshot ([ref=N])." }),
      value: FieldValue,
    }),
    { minItems: 1, description: "Fields to fill in one batch, each by ref." },
  ),
});

export const fillFormTool = defineBrowserTool({
  name: "browser_fill_form",
  label: "Browser Fill Form",
  description:
    "Fill multiple form fields in one call — the efficient way to complete a form. Each field is { ref, value }; refs come from browser_snapshot's [ref=N]. Handles text inputs, textareas, selects, checkboxes, radios, and contenteditable, drives React/Vue controlled inputs correctly, and reports the resulting value of every field.",
  promptSnippet: "Fill many form fields at once by ref — React-safe, self-confirming",
  promptGuidelines: [
    "Preferred for forms: snapshot once, then fill all fields in a single browser_fill_form call.",
    "Each field: { ref, value }. value is a string for text/select/contenteditable, boolean for checkbox/radio.",
    "The result summarizes how many fields filled cleanly and flags any value mismatches or per-field errors.",
    "Re-run browser_snapshot afterwards to verify the form state if needed.",
  ],
  parameters: FillFormArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const results: Array<Readonly<Record<string, unknown>>> = [];
    let okCount = 0;
    const issues: string[] = [];
    for (const f of args.fields) {
      const r = await resolveAndCall(client, f.ref, FILL_FN, [f.value]);
      if (!r.success) {
        results.push({ ref: f.ref, ok: false, error: r.error.message });
        issues.push(`ref ${f.ref} (${r.error.message})`);
        continue;
      }
      const res = r.data;
      const wanted = typeof f.value === "boolean" ? undefined : String(f.value);
      const got = res.value !== undefined ? String(res.value) : undefined;
      const mismatch = wanted !== undefined && got !== undefined && got !== wanted;
      const fieldOk = res.ok === true && !mismatch;
      if (fieldOk) okCount++;
      else issues.push(`ref ${f.ref} (${res.ok === false ? (res.reason ?? "failed") : "value mismatch"})`);
      results.push({ ref: f.ref, ok: fieldOk, mismatch, ...detailsOf(f.ref, res) });
    }
    const text =
      `Filled ${okCount}/${args.fields.length} fields` +
      (issues.length > 0 ? `; issues: ${issues.join(", ")}` : "");
    return ok({ text, details: { results } });
  },
});

const SelectOptionArgs = Type.Object({
  ref: Type.Integer({ description: "Element ref of a <select> from browser_snapshot ([ref=N])." }),
  value: Type.Optional(Type.String({ description: "Option value attribute to select." })),
  label: Type.Optional(Type.String({ description: "Visible option text/label to select (used if value is omitted)." })),
});

export const selectOptionTool = defineBrowserTool({
  name: "browser_select_option",
  label: "Browser Select Option",
  description:
    "Select an option in a native <select> dropdown by ref. Matches by option value, then by visible label/text, and fires change. Native selects cannot be driven by clicking coordinates — use this instead. Get the ref from browser_snapshot's [ref=N].",
  promptSnippet: "Choose an option in a <select> dropdown by ref",
  promptGuidelines: [
    "Provide value (the option's value attribute) or label (the visible text). value wins if both given.",
    "On no match, the result lists the available options so you can retry with a valid one.",
    "Use this for native <select> elements — clicking coordinates does not work for OS dropdowns.",
  ],
  parameters: SelectOptionArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    if (args.value === undefined && args.label === undefined) {
      return err({ kind: "invalid_state", message: "Provide value or label to select an option." });
    }
    const r = await resolveAndCall(client, args.ref, SELECT_FN, [args.value ?? null, args.label ?? null]);
    if (!r.success) return r;
    const res = r.data;
    if (!res.ok) {
      return err({ kind: "invalid_state", message: `Could not select option on ref ${args.ref}: ${res.reason ?? "unknown reason"}`, details: detailsOf(args.ref, res) });
    }
    return ok({
      text: `Selected ${JSON.stringify(res.text)} (value=${JSON.stringify(res.value)}) on ref ${args.ref}`,
      details: detailsOf(args.ref, res),
    });
  },
});

const SetCheckedArgs = Type.Object({
  ref: Type.Integer({ description: "Element ref of a checkbox or radio from browser_snapshot ([ref=N])." }),
  checked: Type.Boolean({ description: "Desired checked state." }),
});

export const setCheckedTool = defineBrowserTool({
  name: "browser_set_checked",
  label: "Browser Set Checked",
  description:
    "Set a checkbox or radio to a desired checked state by ref. Only acts if the current state differs, fires change, and reports the final state. Get the ref from browser_snapshot's [ref=N].",
  promptSnippet: "Set a checkbox/radio checked state by ref",
  promptGuidelines: [
    "checked:true ticks the box, checked:false unticks it. Idempotent — no-op if already in the desired state.",
    "For radios, set checked:true on the option you want; the group deselects the others.",
  ],
  parameters: SetCheckedArgs,
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
