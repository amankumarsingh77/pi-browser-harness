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

// Visible status and alert messages (toasts, live regions), which carry no ref, so a recipe can expect one.
// A live region without one of the message roles is reported as status (polite) or alert (assertive).
export function liveMessages(): Array<{ role: string; name: string }> {
  const roles = ["status", "alert", "alertdialog"];
  const out: Array<{ role: string; name: string }> = [];
  const found = document.querySelectorAll("[role=status],[role=alert],[role=alertdialog],[aria-live=polite],[aria-live=assertive]");
  for (const el of Array.from(found)) {
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) continue;
    const name = el.textContent.replace(/\s+/g, " ").trim().slice(0, 200);
    if (name === "") continue;
    const explicit = el.getAttribute("role") ?? "";
    const role = roles.includes(explicit) ? explicit : el.getAttribute("aria-live") === "assertive" ? "alert" : "status";
    out.push({ role, name });
  }
  return out;
}
