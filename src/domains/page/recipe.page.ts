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

// A hash of everything a script could change on the page: its markup, the live values of its form fields (which
// the markup does not show), its storage and its URL. Two equal hashes around a script mean it only read the page.
export function pageFingerprint(): string {
  const parts: string[] = [location.href, document.documentElement.outerHTML];
  for (const el of Array.from(document.querySelectorAll("input,textarea,select"))) {
    if (el instanceof HTMLInputElement) parts.push(`${el.value}\u0001${String(el.checked)}`);
    else if (el instanceof HTMLTextAreaElement) parts.push(el.value);
    else if (el instanceof HTMLSelectElement) parts.push(String(el.selectedIndex));
  }
  for (const store of [() => localStorage, () => sessionStorage]) {
    try {
      const s = store();
      for (let i = 0; i < s.length; i++) {
        const key = s.key(i) ?? "";
        parts.push(`${key}\u0001${s.getItem(key) ?? ""}`);
      }
    } catch {
      parts.push("storage unavailable");
    }
  }
  let hash = 0x811c9dc5;
  const text = parts.join("\u0000");
  for (let i = 0; i < text.length; i++) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `${hash.toString(16)}:${text.length}`;
}
