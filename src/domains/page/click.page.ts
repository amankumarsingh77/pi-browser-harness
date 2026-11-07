// Page-side code for browser_click; see fill.page.ts for the rules every `*.page.ts` module follows.

// What sits under the click point, relative to the element the click was aimed at.
export type HitInfo = {
  // The point lands on the target, inside it, or on an ancestor that wraps it (a label around an icon).
  readonly onTarget: boolean;
  // A short description of the element actually under the point, e.g. `div.modal-overlay "Close"`.
  readonly hit: string;
};

// `target` is the element the click aims at (Runtime.callFunctionOn's `this`), `hit` the element hit-testing found.
export function hitInfo(target: Element | null, hit: Element | null): HitInfo {
  if (hit?.nodeType !== 1) return { onTarget: false, hit: "nothing" };
  const onTarget = target !== null && (target === hit || target.contains(hit) || hit.contains(target));
  const tag = hit.tagName.toLowerCase();
  const id = hit.id ? "#" + hit.id : "";
  const cls = typeof hit.className === "string" && hit.className.trim() !== ""
    ? "." + hit.className.trim().split(/\s+/).slice(0, 2).join(".")
    : "";
  const label = (hit.getAttribute("aria-label") ?? hit.textContent).replace(/\s+/g, " ").trim().slice(0, 40);
  return { onTarget, hit: tag + id + cls + (label !== "" ? ' "' + label + '"' : "") };
}
