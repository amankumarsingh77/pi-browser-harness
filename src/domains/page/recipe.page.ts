// Page-side checks for the recipe journal and replay. See fill.page.ts for the rules.

// True for an <input type="password">, the one field whose value the journal must never store.
export function isPasswordInput(el: Element): boolean {
  return el instanceof HTMLInputElement && el.type === "password";
}

// The same check for whatever has focus, which is where browser_type writes.
export function focusedIsPassword(): boolean {
  const el = document.activeElement;
  return el instanceof HTMLInputElement && el.type === "password";
}

// The interactive element under a point, so an x/y click can be journaled by role and name.
export function interactiveAt(x: number, y: number): Element | null {
  const hit = document.elementFromPoint(x, y);
  if (hit === null) return null;
  return hit.closest("a,button,input,select,textarea,summary,[role],[contenteditable='true']");
}

// A visible password field means the page is asking the user to sign in.
export function hasVisiblePasswordField(): boolean {
  for (const el of Array.from(document.querySelectorAll("input[type=password]"))) {
    const r = el.getBoundingClientRect();
    if (r.width > 0 && r.height > 0) return true;
  }
  return false;
}
