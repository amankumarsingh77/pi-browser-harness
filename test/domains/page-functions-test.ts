// The failure mode of shipping page functions by `fn.toString()` is a function that quietly depends on something
// outside its own body: an import, a module-level constant, a sibling export. Inside Chrome that is a ReferenceError.
// This file checks every `*.page.ts` module for that, then exercises each function against a minimal fake DOM.
import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { type PageFunction, pageFunctionSource } from "../../src/domains/page/inject";
import { focusElement, selectOption, setChecked } from "../../src/domains/page/form.page";
import { liveValue } from "../../src/domains/page/live-value.page";
import { capturePage } from "../../src/domains/page/read-page.page";
import { extractSerp } from "../../src/domains/page/serp.page";
import { asRecord } from "../../src/util/guards";
import { callPage, materialise } from "./page-harness";

const PAGE_DIR = join(import.meta.dirname, "..", "..", "src", "domains", "page");
const EXPECTED_FUNCTIONS = ["fillField", "focusElement", "selectOption", "setChecked", "liveValue", "capturePage", "extractSerp", "dispatchKeyEvent"];

const pageModules = (): ReadonlyArray<string> => readdirSync(PAGE_DIR).filter((f) => f.endsWith(".page.ts"));

const isPageFunction = (v: unknown): v is PageFunction => typeof v === "function";

const exportedFunctions = async (file: string): Promise<ReadonlyArray<[string, PageFunction]>> => {
  const mod: unknown = await import(pathToFileURL(join(PAGE_DIR, file)).href);
  const record = asRecord(mod) ?? {};
  const out: Array<[string, PageFunction]> = [];
  for (const [name, value] of Object.entries(record)) {
    if (isPageFunction(value)) out.push([name, value]);
  }
  return out;
};

describe("every page module is a bag of self-contained function declarations", () => {
  test("the known page functions are all present", async () => {
    const names: string[] = [];
    for (const file of pageModules()) for (const [name] of await exportedFunctions(file)) names.push(name);
    for (const expected of EXPECTED_FUNCTIONS) assert.ok(names.includes(expected), `${expected} is missing`);
  });

  for (const file of pageModules()) {
    const source = readFileSync(join(PAGE_DIR, file), "utf8");

    test(`${file}: imports are type-only and there is no module-scope runtime state`, () => {
      const runtimeImports = source.match(/^import (?!type\b)/gm) ?? [];
      assert.deepEqual(runtimeImports, [], "a runtime import would not travel with the function source");
      const moduleState = source.match(/^(?:export )?(?:const|let|var|class)\b.*$/gm) ?? [];
      assert.deepEqual(moduleState, [], "module-scope declarations are invisible inside the page");
    });

    test(`${file}: every export is a function declaration that does not reference its siblings`, async () => {
      const fns = await exportedFunctions(file);
      assert.ok(fns.length > 0, "a page module must export at least one function");
      for (const [name, fn] of fns) {
        const text = pageFunctionSource(fn);
        assert.match(text, /^function\b/, `${name} must stringify to a function declaration`);
        // tsx/esbuild emits `__name(...)` around named inner functions; that helper lives in module scope, not the page.
        assert.doesNotMatch(text, /\b__[A-Za-z]+\s*\(/, `${name} contains a loader helper call; avoid named inner functions`);
        for (const [other] of fns) {
          if (other === name) continue;
          assert.doesNotMatch(text, new RegExp(`\\b${other}\\b`), `${name} references sibling export ${other}`);
        }
        assert.equal(typeof materialise(fn), "function", `${name} must re-materialise from its own text`);
      }
    });
  }
});

// A minimal element: enough surface for the form, live-value and capture functions.
type Fake = {
  tagName: string;
  nodeType: number;
  type?: string;
  value?: string;
  checked?: boolean;
  disabled?: boolean;
  options?: Array<{ value: string; text: string; label: string }>;
  fired: string[];
  focused: boolean;
  focus?: () => void;
  click?: () => void;
  dispatchEvent: (e: { type: string }) => boolean;
};

const fake = (tagName: string, extra: Partial<Fake> = {}): Fake => {
  const el: Fake = {
    tagName,
    nodeType: 1,
    fired: [],
    focused: false,
    dispatchEvent(e) {
      el.fired.push(e.type);
      return true;
    },
    ...extra,
  };
  return el;
};

const focusable = (tagName: string): Fake => {
  const el = fake(tagName);
  el.focus = () => {
    el.focused = true;
    Object.assign(globalThis, { document: { ...asRecord(Reflect.get(globalThis, "document")), activeElement: el } });
  };
  return el;
};

before(() => {
  Object.assign(globalThis, { document: { activeElement: null } });
});

describe("focusElement", () => {
  test("reports ok when focus lands on the element", () => {
    const el = focusable("INPUT");
    assert.deepEqual(callPage(focusElement, el), { status: "ok", tag: "INPUT" });
    assert.equal(el.focused, true);
  });

  test("reports not_focusable when the element has no focus method", () => {
    assert.deepEqual(callPage(focusElement, fake("SVG")), { status: "not_focusable", tag: "SVG" });
  });
});

describe("selectOption", () => {
  const select = (): Fake =>
    fake("SELECT", {
      value: "",
      options: [
        { value: "in", text: "India", label: "India" },
        { value: "us", text: "United States", label: "United States" },
      ],
    });

  test("matches by value, label or index and fires input then change", () => {
    const byValue = select();
    assert.deepEqual(callPage(selectOption, byValue, { wv: "us", wl: null, wi: null }), { status: "ok", value: "us", label: "United States" });
    assert.deepEqual(byValue.fired, ["input", "change"]);
    assert.equal(byValue.value, "us");
    assert.deepEqual(callPage(selectOption, select(), { wv: null, wl: "India", wi: null }), { status: "ok", value: "in", label: "India" });
    assert.deepEqual(callPage(selectOption, select(), { wv: null, wl: null, wi: 1 }), { status: "ok", value: "us", label: "United States" });
  });

  test("lists the options when nothing matches", () => {
    const r = asRecord(callPage(selectOption, select(), { wv: "xx", wl: null, wi: null })) ?? {};
    assert.equal(r["status"], "no_match");
    assert.deepEqual(r["options"], [
      { value: "in", label: "India" },
      { value: "us", label: "United States" },
    ]);
  });

  test("refuses a non-select", () => {
    assert.deepEqual(callPage(selectOption, fake("DIV"), { wv: "x", wl: null, wi: null }), { status: "not_select", tag: "DIV" });
  });
});

describe("setChecked", () => {
  const checkbox = (checked: boolean): Fake => {
    const el = fake("INPUT", { type: "checkbox", checked, disabled: false });
    el.click = () => {
      el.checked = !el.checked;
      el.fired.push("click");
    };
    return el;
  };

  test("clicks to reach the wanted state", () => {
    const el = checkbox(false);
    assert.deepEqual(callPage(setChecked, el, true), { ok: true, kind: "checkbox", checked: true, changed: true, tag: "INPUT" });
    assert.deepEqual(el.fired, ["click"]);
  });

  test("leaves an already-correct state alone", () => {
    const el = checkbox(true);
    assert.deepEqual(callPage(setChecked, el, true), { ok: true, kind: "checkbox", checked: true, changed: false, tag: "INPUT" });
    assert.deepEqual(el.fired, []);
  });

  test("refuses a disabled checkbox and a non-checkbox", () => {
    const disabled = checkbox(false);
    disabled.disabled = true;
    assert.deepEqual(callPage(setChecked, disabled, true), { ok: false, reason: "element is disabled" });
    assert.deepEqual(callPage(setChecked, fake("INPUT", { type: "text" }), true), { ok: false, reason: "ref is not a checkbox or radio" });
  });
});

describe("liveValue", () => {
  test("reads checked state for checkboxes and the value for text fields", () => {
    assert.equal(callPage(liveValue, fake("INPUT", { type: "checkbox", checked: true })), "checked");
    assert.equal(callPage(liveValue, fake("INPUT", { type: "radio", checked: false })), "unchecked");
    assert.equal(callPage(liveValue, fake("INPUT", { type: "text", value: "typed" })), "typed");
    assert.equal(callPage(liveValue, fake("DIV")), null);
  });
});

// A tiny document for the two capture functions: elements with innerText and the query methods they call.
type Node = {
  tagName: string;
  innerText: string;
  textContent: string;
  href?: string;
  parentElement: Node | null;
  attrs: Readonly<Record<string, string>>;
  children: Node[];
  getAttribute: (name: string) => string | null;
  querySelectorAll: (selector: string) => Node[];
  querySelector: (selector: string) => Node | null;
  closest: (selector: string) => Node | null;
};

const node = (tagName: string, innerText: string, opts: { attrs?: Record<string, string>; href?: string; children?: Node[] } = {}): Node => {
  const n: Node = {
    tagName,
    innerText,
    textContent: innerText,
    parentElement: null,
    attrs: opts.attrs ?? {},
    children: opts.children ?? [],
    getAttribute: (name) => n.attrs[name] ?? null,
    querySelectorAll: (selector) => descendants(n).filter((d) => matches(d, selector)),
    querySelector: (selector) => descendants(n).find((d) => matches(d, selector)) ?? null,
    closest: (selector) => {
      for (let cur: Node | null = n; cur; cur = cur.parentElement) if (matches(cur, selector)) return cur;
      return null;
    },
  };
  if (opts.href !== undefined) n.href = opts.href;
  for (const c of n.children) c.parentElement = n;
  return n;
};

const descendants = (n: Node): Node[] => n.children.flatMap((c) => [c, ...descendants(c)]);

// Supports the selector shapes the page functions use: tag lists, "a h3", "a[href]", "div.g", "div[data-hveid]".
const matches = (n: Node, selector: string): boolean =>
  selector.split(",").some((part) => {
    const s = part.trim();
    if (s === "a h3") return n.tagName === "H3" && n.closest("a[href]") !== null;
    if (s === "a[href]") return n.tagName === "A" && n.href !== undefined;
    if (s === "div.g") return n.tagName === "DIV" && n.attrs["class"] === "g";
    if (s === "div[data-hveid]") return n.tagName === "DIV" && "data-hveid" in n.attrs;
    if (s === "[role=main]") return n.attrs["role"] === "main";
    if (s.startsWith("#")) return n.attrs["id"] === s.slice(1);
    return n.tagName === s.toUpperCase();
  });

const installDocument = (body: Node, title: string, href: string): void => {
  Object.assign(globalThis, {
    document: { title, body, querySelector: (selector: string) => body.querySelectorAll(selector)[0] ?? null },
    location: { href },
  });
};

describe("capturePage", () => {
  test("captures blocks with kind, link length and boilerplate flag as JSON text", () => {
    const nav = node("NAV", "Home", { children: [node("LI", "Home")] });
    const article = node("ARTICLE", "", {
      children: [
        node("H1", "Title"),
        node("P", "Read   more here", { children: [node("A", "here", { href: "https://x/" })] }),
        node("P", "   "),
      ],
    });
    installDocument(node("BODY", "Home\n\n\n\nTitle Read more here", { children: [nav, article] }), "T", "https://example.test/a");
    const raw = callPage(capturePage, 12);
    assert.equal(typeof raw, "string");
    const parsed: unknown = JSON.parse(String(raw));
    assert.deepEqual(parsed, {
      url: "https://example.test/a",
      title: "T",
      blocks: [
        { kind: "heading", text: "Title", linkTextLength: 0, inBoilerplate: false },
        { kind: "paragraph", text: "Read more here", linkTextLength: 4, inBoilerplate: false },
      ],
      bodyText: "Home\n\nTitle ",
    });
  });

  test("falls back to the body and flags boilerplate when there is no article", () => {
    const nav = node("NAV", "", { children: [node("LI", "Home")] });
    installDocument(node("BODY", "Home", { children: [nav] }), "T", "https://example.test/");
    const parsed = asRecord(JSON.parse(String(callPage(capturePage, 100))));
    assert.deepEqual(parsed?.["blocks"], [{ kind: "listitem", text: "Home", linkTextLength: 0, inBoilerplate: true }]);
  });

});

describe("extractSerp", () => {
  test("collects one anchor per unique result link with its container snippet", () => {
    const result = (href: string, heading: string, snippet: string, cite?: string): Node =>
      node("DIV", `${heading}\n${snippet}`, {
        attrs: { class: "g" },
        children: [
          node("A", heading, { href, children: [node("H3", heading)] }),
          ...(cite === undefined ? [] : [node("CITE", ` ${cite} `)]),
        ],
      });
    const search = node("DIV", "", {
      attrs: { id: "search" },
      children: [
        result("https://google/goto?url=CAES", "A title", "A snippet", "https://a › x"),
        result("https://google/goto?url=CAES", "A again", "dup"),
        result("https://b/", "B title", "B  snippet"),
      ],
    });
    installDocument(node("BODY", "A title A snippet B title", { children: [search] }), "q - Google", "https://google/");
    const parsed: unknown = JSON.parse(String(callPage(extractSerp, 7)));
    assert.deepEqual(parsed, {
      anchors: [
        { href: "https://google/goto?url=CAES", heading: "A title", snippet: "A snippet", cite: "https://a › x" },
        { href: "https://b/", heading: "B title", snippet: "B snippet", cite: "" },
      ],
      pageText: "A title",
    });
  });

});
