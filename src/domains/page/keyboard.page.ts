// Page-side code for browser_dispatch_key. See fill.page.ts for the rules.

export type KeyEventSpec = {
  readonly type: string;
  readonly key: string;
  // Legacy handlers branch on e.keyCode/e.which rather than e.key, so both are populated from this.
  readonly code: number;
};

// Dispatches a synthetic KeyboardEvent on `el`; returns the number of elements hit (always 1 here).
export function dispatchKeyEvent(el: Element, spec: KeyEventSpec): number {
  el.dispatchEvent(
    new KeyboardEvent(spec.type, { key: spec.key, keyCode: spec.code, which: spec.code, bubbles: true, cancelable: true }),
  );
  return 1;
}
