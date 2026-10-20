// Page-side code: the exported function's SOURCE TEXT is injected into Chrome (see ./inject.ts).
// Rules for every `*.page.ts` module (enforced by test/domains/page-functions-test.ts):
//   - export plain `function` declarations only (no arrows — tsx strips a single parameter's parentheses)
//   - a function must be self-contained: no references to module scope, imports or other exports
//   - no NAMED inner functions (`function f() {}`, `const f = () => {}`): tsx/esbuild wraps those in a module-level
//     `__name` helper that does not travel with the source; anonymous callbacks such as `.find((o) => …)` are fine
//   - inputs arrive as arguments, never by string interpolation
//   - only `import type` is allowed, so the module has no runtime dependencies

export type PageOption = { readonly value: string; readonly text: string };

export type FillOptions = {
  // browser_fill refuses a <select> (its documented error points at browser_select_option); browser_fill_form fills it.
  readonly rejectSelect: boolean;
  readonly focusFirst: boolean;
};

// What the fill engine (fillField) and the checkbox function (form.page.ts setChecked) return from the page.
export type PageResult =
  | { readonly ok: true; readonly kind: "select"; readonly value: string; readonly text: string; readonly tag: string }
  | { readonly ok: true; readonly kind: "checkbox" | "radio"; readonly checked: boolean; readonly changed: boolean; readonly tag: string }
  | { readonly ok: true; readonly kind: "input" | "textarea" | "contenteditable"; readonly value: string; readonly tag: string }
  | {
      readonly ok: false;
      readonly reason: string;
      readonly tag?: string;
      // "select_rejected": the engine was told not to touch a <select>; "no_match": a <select> had no such option.
      readonly code?: "select_rejected" | "no_match";
      readonly options?: ReadonlyArray<PageOption>;
    };

// The element a form function receives, typed the way the functions treat it: an HTML element that MAY
// carry the form-control properties, discovered at runtime by tag rather than by instanceof, so the functions behave
// identically on every element the page hands over.
export type FormControl = HTMLElement & {
  type?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  options?: HTMLOptionsCollection;
};

// Writes `value` into `el` the way a user would: through the native value setter (so React/Vue controlled inputs
// notice), via click for checkboxes, execCommand for rich-text editors. Element functions take the element as their
// first parameter; inject.ts's elementFunctionSource forwards Runtime.callFunctionOn's `this` into it.
export function fillField(el: FormControl | null, value: unknown, opts: FillOptions): PageResult {
  if (el?.nodeType !== 1) return { ok: false, reason: "ref does not point to an element" };
  const tagName = el.tagName;
  const tag = tagName.toLowerCase();
  const type = (el.type ?? "").toLowerCase();

  if (opts.rejectSelect && tag === "select") {
    return { ok: false, reason: "element is a <select>", code: "select_rejected", tag: tagName };
  }
  if (el.disabled) return { ok: false, reason: "element is disabled", tag: tagName };

  if (opts.focusFirst) {
    try {
      el.focus();
    } catch {
      /* focus throws on some detached or shadow nodes; a missed focus is not a failed fill */
    }
  }

  if (tag === "select" && el.options !== undefined) {
    const want = String(value);
    let matched: HTMLOptionElement | null = null;
    for (const o of el.options) {
      if (o.value === want || o.label === want || o.text === want) {
        matched = o;
        break;
      }
    }
    if (!matched) {
      const options: PageOption[] = [];
      for (const o of el.options) options.push({ value: o.value, text: o.text });
      return { ok: false, reason: "no matching option", code: "no_match", options, tag: tagName };
    }
    el.value = matched.value;
    for (const t of ["input", "change"]) el.dispatchEvent(new Event(t, { bubbles: true }));
    return { ok: true, kind: "select", value: el.value ?? "", text: matched.text, tag: tagName };
  }

  if (tag === "input" && (type === "checkbox" || type === "radio")) {
    const want = value === true || value === "true" || value === "on" || value === 1;
    let changed = false;
    if (el.checked !== want) {
      try {
        el.click();
      } catch {
        /* a click handler may throw; the direct write below still applies the state */
      }
      if (el.checked !== want) {
        el.checked = want;
        for (const t of ["input", "change"]) el.dispatchEvent(new Event(t, { bubbles: true }));
      }
      changed = true;
    }
    return { ok: true, kind: type, checked: el.checked, changed, tag: tagName };
  }

  if (el.isContentEditable) {
    try {
      el.focus();
    } catch {
      /* see above */
    }
    let done = false;
    try {
      const sel = window.getSelection();
      if (sel) {
        sel.removeAllRanges();
        const rng = document.createRange();
        rng.selectNodeContents(el);
        sel.addRange(rng);
      }
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- insertText is still the one way to drive ProseMirror/Quill-style editors through their own input path
      done = document.execCommand("insertText", false, String(value));
    } catch {
      /* execCommand unavailable or refused; fall through to the textContent write */
    }
    if (!done) {
      el.textContent = String(value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    return { ok: true, kind: "contenteditable", value: el.textContent, tag: tagName };
  }

  if (tag === "input" || tag === "textarea") {
    const proto = tag === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc?.set) desc.set.call(el, String(value));
    else el.value = String(value);
    for (const t of ["input", "change"]) el.dispatchEvent(new Event(t, { bubbles: true }));
    return { ok: true, kind: tag, value: el.value ?? "", tag: tagName };
  }

  return { ok: false, reason: "element is not a fillable field (tag=" + tag + ")", tag: tagName };
}
