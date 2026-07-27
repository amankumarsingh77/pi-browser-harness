import { Type } from "typebox";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { detailsOf, resolveAndCall } from "./form";

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

const FieldValue = Type.Union([Type.String(), Type.Boolean()], {
  description: "Value to set. String for text inputs / textareas / selects / contenteditable; boolean for checkboxes & radios.",
});

const FillFormArgs = Type.Object({
  fields: Type.Array(
    Type.Object({
      ref: Type.String({ description: "Stable element ref from browser_snapshot (e.g. 'e7')." }),
      value: FieldValue,
    }),
    { minItems: 1, description: "Fields to fill in one batch, each by ref." },
  ),
});

export const fillFormTool = defineBrowserTool({
  name: "browser_fill_form",
  label: "Browser Fill Form",
  description:
    "Fill multiple form fields in one call — the efficient way to complete a form. Each field is { ref, value }; refs come from browser_snapshot's [eN]. Handles text inputs, textareas, selects, checkboxes, radios, and contenteditable, drives React/Vue controlled inputs correctly, and reports the resulting value of every field.",
  promptSnippet: "Fill many form fields at once by ref — React-safe, self-confirming",
  promptGuidelines: [
    "Preferred for forms: snapshot once, then fill all fields in a single browser_fill_form call.",
    "Each field: { ref, value }. value is a string for text/select/contenteditable, boolean for checkbox/radio.",
    "The result summarizes how many fields filled cleanly and flags any value mismatches or per-field errors.",
    "Re-run browser_snapshot afterwards to verify the form state if needed.",
  ],
  parameters: FillFormArgs,
  concurrency: "serialized",
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
      const mismatch = wanted !== undefined && got !== undefined && got !== wanted && res.text !== wanted;
      const fieldOk = res.ok === true && !mismatch;
      if (fieldOk) okCount++;
      else issues.push(`ref ${f.ref} (${res.ok === false ? (res.reason ?? "failed") : "value mismatch"})`);
      results.push({ ref: f.ref, ok: fieldOk, mismatch, ...detailsOf(f.ref, res) });
    }
    const text =
      `Filled ${okCount}/${args.fields.length} fields` +
      (issues.length > 0 ? `; issues: ${issues.join(", ")}` : "");
    if (okCount === 0) {
      return err({ kind: "invalid_state", message: text, details: { results } });
    }
    return ok({ text, details: { results } });
  },
});
