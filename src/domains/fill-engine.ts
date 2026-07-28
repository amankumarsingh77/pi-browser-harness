export type FillOptions = {
  readonly rejectSelect: boolean;
  readonly focusFirst: boolean;
};

const ENGINE = `
  const el = this;
  if (!el || el.nodeType !== 1) return { ok: false, reason: "ref does not point to an element" };
  const tagName = el.tagName || "";
  const tag = tagName.toLowerCase();
  const type = (el.type || "").toLowerCase();

  if (__rejectSelect && tag === "select") {
    return { ok: false, reason: "element is a <select>", kind: "select", tag: tagName };
  }
  if (el.disabled) return { ok: false, reason: "element is disabled", tag: tagName };

  const fire = function (t) { el.dispatchEvent(new Event(t, { bubbles: true })); };
  if (__focusFirst) { try { el.focus(); } catch (e) {} }

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
      return { ok: false, reason: "no matching option", kind: "select", options: opts, tag: tagName };
    }
    el.value = matched.value;
    fire("input"); fire("change");
    return { ok: true, kind: "select", value: el.value, text: matched.text, tag: tagName };
  }

  if (tag === "input" && (type === "checkbox" || type === "radio")) {
    const want = value === true || value === "true" || value === "on" || value === 1;
    let changed = false;
    if (el.checked !== want) {
      try { el.click(); } catch (e) {}
      if (el.checked !== want) { el.checked = want; fire("input"); fire("change"); }
      changed = true;
    }
    return { ok: true, kind: type, checked: el.checked, changed: changed, tag: tagName };
  }

  if (el.isContentEditable) {
    try { el.focus(); } catch (e) {}
    let done = false;
    try {
      const sel = window.getSelection();
      if (sel) { sel.removeAllRanges(); const rng = document.createRange(); rng.selectNodeContents(el); sel.addRange(rng); }
      done = document.execCommand("insertText", false, String(value));
    } catch (e) { done = false; }
    if (!done) {
      el.textContent = String(value);
      el.dispatchEvent(new InputEvent("input", { bubbles: true }));
    }
    return { ok: true, kind: "contenteditable", value: el.textContent || "", tag: tagName };
  }

  if (tag === "input" || tag === "textarea") {
    const proto = tag === "textarea" ? window.HTMLTextAreaElement.prototype : window.HTMLInputElement.prototype;
    const desc = Object.getOwnPropertyDescriptor(proto, "value");
    if (desc && desc.set) desc.set.call(el, String(value));
    else el.value = String(value);
    fire("input"); fire("change");
    return { ok: true, kind: el.type || tag, value: el.value, tag: tagName };
  }

  return { ok: false, reason: "element is not a fillable field (tag=" + tag + ")", tag: tagName };
`;

export const fillBody = (opts: FillOptions): string =>
  `const __rejectSelect = ${opts.rejectSelect}; const __focusFirst = ${opts.focusFirst};\n${ENGINE}`;

export const fillDeclaration = (opts: FillOptions): string =>
  `function (value) { ${fillBody(opts)} }`;
