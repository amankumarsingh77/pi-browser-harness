// Page-side code for browser_focus, browser_select_option and browser_set_checked. See fill.page.ts for the rules.
import type { FormControl, PageResult } from "./fill.page";

export type FocusResult = { readonly status: "ok"; readonly tag: string } | { readonly status: "not_focusable"; readonly tag: string };

export function focusElement(el: Element & { focus?: () => void }): FocusResult {
  if (typeof el.focus !== "function") return { status: "not_focusable", tag: el.tagName };
  el.focus();
  return document.activeElement === el ? { status: "ok", tag: el.tagName } : { status: "not_focusable", tag: el.tagName };
}

export type SelectOption = { readonly value: string; readonly label: string };

export type SelectResult =
  | { readonly status: "ok"; readonly value: string; readonly label: string }
  | { readonly status: "not_select"; readonly tag: string }
  | { readonly status: "no_match"; readonly options: ReadonlyArray<SelectOption> };

// null sentinels distinguish "not provided" from a real empty-string match.
export type SelectWanted = {
  readonly wv: string | null;
  readonly wl: string | null;
  readonly wi: number | null;
};

export function selectOption(el: FormControl, arg: SelectWanted): SelectResult {
  if (el.tagName !== "SELECT" || el.options === undefined) return { status: "not_select", tag: el.tagName };
  const opts = Array.from(el.options);
  const wv = arg.wv, wl = arg.wl, wi = arg.wi;
  let opt: HTMLOptionElement | null = null;
  if (wi !== null) opt = opts[wi] ?? null;
  else if (wv !== null) opt = opts.find((o) => o.value === wv) ?? null;
  else if (wl !== null) opt = opts.find((o) => o.text === wl) ?? null;
  if (!opt) return { status: "no_match", options: opts.map((o) => ({ value: o.value, label: o.text })) };
  el.value = opt.value;
  el.dispatchEvent(new Event("input", { bubbles: true }));
  el.dispatchEvent(new Event("change", { bubbles: true }));
  return { status: "ok", value: opt.value, label: opt.text };
}

export function setChecked(el: FormControl, checked: boolean): PageResult {
  const tag = el.tagName.toLowerCase();
  const type = (el.type ?? "").toLowerCase();
  if (tag !== "input" || (type !== "checkbox" && type !== "radio")) return { ok: false, reason: "ref is not a checkbox or radio" };
  if (el.disabled) return { ok: false, reason: "element is disabled" };
  const want = checked;
  let changed = false;
  if (el.checked !== want) {
    try {
      el.click();
    } catch {
      /* a click handler may throw; the direct write below still applies the state */
    }
    if (el.checked !== want) {
      el.checked = want;
      el.dispatchEvent(new Event("change", { bubbles: true }));
    }
    changed = true;
  }
  return { ok: true, kind: type, checked: el.checked, changed, tag: el.tagName };
}
