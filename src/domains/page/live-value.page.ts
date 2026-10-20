// Page-side code for the snapshot's live value read. See fill.page.ts for the rules.

// The AX `value` is stale for freshly-typed or controlled inputs, so the live DOM property is read instead.
export function liveValue(el: Element): string | null {
  if ("type" in el && (el.type === "checkbox" || el.type === "radio")) {
    return "checked" in el && el.checked ? "checked" : "unchecked";
  }
  if ("value" in el && typeof el.value === "string") return el.value;
  return null;
}
