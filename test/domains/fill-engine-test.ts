import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { fillBody, type FillOptions } from "../../src/domains/fill-engine";

type Fired = string[];

class FakeHTMLElement {
  tagName = "DIV";
  nodeType = 1;
  disabled = false;
  isContentEditable = false;
  textContent = "";
  focused = false;
  fired: Fired = [];
  protoSetterUsed = false;
  dispatchEvent(e: { type: string }): boolean {
    this.fired.push(e.type);
    return true;
  }
  focus(): void {
    this.focused = true;
  }
  querySelectorAll(): ReadonlyArray<never> {
    return [];
  }
}

class FakeHTMLInputElement extends FakeHTMLElement {
  override tagName = "INPUT";
  type = "text";
  checked = false;
  options: ReadonlyArray<{ value: string; text: string; label: string }> = [];
  click(): void {
    this.checked = !this.checked;
    this.fired.push("click");
  }
}

class FakeHTMLTextAreaElement extends FakeHTMLElement {
  override tagName = "TEXTAREA";
  type = "textarea";
}

class FakeHTMLSelectElement extends FakeHTMLElement {
  override tagName = "SELECT";
  type = "select-one";
  value = "";
  options: Array<{ value: string; text: string; label: string }> = [];
}

const defineValueSetter = (proto: object): void => {
  Object.defineProperty(proto, "value", {
    configurable: true,
    get(): string {
      return "";
    },
    set(this: FakeHTMLElement, v: string): void {
      this.protoSetterUsed = true;
      Object.defineProperty(this, "value", { value: v, writable: true, enumerable: true, configurable: true });
    },
  });
};

let execCommandCalls: Array<{ command: string; value: unknown }> = [];
let execCommandWorks = true;

before(() => {
  defineValueSetter(FakeHTMLInputElement.prototype);
  defineValueSetter(FakeHTMLTextAreaElement.prototype);
  Object.assign(globalThis, {
    HTMLInputElement: FakeHTMLInputElement,
    HTMLTextAreaElement: FakeHTMLTextAreaElement,
    InputEvent: class {
      type: string;
      constructor(type: string) {
        this.type = type;
      }
    },
    window: {
      HTMLInputElement: FakeHTMLInputElement,
      HTMLTextAreaElement: FakeHTMLTextAreaElement,
      getSelection: () => ({ removeAllRanges: () => {}, addRange: () => {} }),
    },
    document: {
      createRange: () => ({ selectNodeContents: () => {} }),
      execCommand: (command: string, _show: boolean, value: unknown) => {
        execCommandCalls.push({ command, value });
        return execCommandWorks;
      },
    },
  });
});

const AS_FILL: FillOptions = { rejectSelect: true, focusFirst: false };
const AS_FILL_FORM: FillOptions = { rejectSelect: false, focusFirst: true };

const runFill = (el: FakeHTMLElement, value: unknown, opts: FillOptions): Record<string, unknown> => {
  const fn = new Function("value", fillBody(opts));
  const out: unknown = fn.call(el, value);
  assert.ok(typeof out === "object" && out !== null, "engine returned no result object");
  return { ...(out as Record<string, unknown>) };
};

const textInput = (): FakeHTMLInputElement => {
  const el = new FakeHTMLInputElement();
  el.protoSetterUsed = false;
  return el;
};

const checkbox = (): FakeHTMLInputElement => {
  const el = textInput();
  el.type = "checkbox";
  return el;
};

describe("fill engine — text fields", () => {
  test("writes through the prototype setter so controlled inputs update", () => {
    const el = textInput();
    const res = runFill(el, "hello", AS_FILL);
    assert.equal(res["ok"], true);
    assert.equal(el.protoSetterUsed, true);
    assert.equal(Reflect.get(el, "value"), "hello");
    assert.deepEqual(el.fired, ["input", "change"]);
  });

  test("fills a textarea the same way", () => {
    const el = new FakeHTMLTextAreaElement();
    el.protoSetterUsed = false;
    const res = runFill(el, "body text", AS_FILL);
    assert.equal(res["ok"], true);
    assert.equal(el.protoSetterUsed, true);
    assert.equal(Reflect.get(el, "value"), "body text");
  });
});

describe("fill engine — checkboxes", () => {
  test("ticking a checkbox changes checked, not value", () => {
    const el = checkbox();
    const res = runFill(el, "true", AS_FILL);
    assert.equal(res["ok"], true);
    assert.equal(el.checked, true);
    assert.equal(el.protoSetterUsed, false, "the value setter must not be used on a checkbox");
    assert.equal(res["kind"], "checkbox");
  });

  test("a boolean also ticks it, for the batch tool's schema", () => {
    const el = checkbox();
    const res = runFill(el, true, AS_FILL_FORM);
    assert.equal(res["ok"], true);
    assert.equal(el.checked, true);
  });

  test("ticking an already-ticked checkbox leaves it ticked", () => {
    const el = checkbox();
    el.checked = true;
    const res = runFill(el, "true", AS_FILL);
    assert.equal(res["ok"], true);
    assert.equal(el.checked, true);
  });

  test("unticking a ticked checkbox clears it", () => {
    const el = checkbox();
    el.checked = true;
    const res = runFill(el, false, AS_FILL_FORM);
    assert.equal(res["ok"], true);
    assert.equal(el.checked, false);
  });
});

describe("fill engine — disabled controls", () => {
  test("a disabled input is refused instead of written through", () => {
    const el = textInput();
    el.disabled = true;
    const res = runFill(el, "nope", AS_FILL);
    assert.equal(res["ok"], false);
    assert.match(String(res["reason"]), /disabled/);
    assert.equal(el.protoSetterUsed, false);
    assert.deepEqual(el.fired, []);
  });

  test("a disabled checkbox is refused too", () => {
    const el = checkbox();
    el.disabled = true;
    const res = runFill(el, "true", AS_FILL);
    assert.equal(res["ok"], false);
    assert.equal(el.checked, false);
  });
});

describe("fill engine — selects", () => {
  const select = (): FakeHTMLSelectElement => {
    const el = new FakeHTMLSelectElement();
    el.options = [
      { value: "in", text: "India", label: "India" },
      { value: "us", text: "United States", label: "United States" },
    ];
    return el;
  };

  test("browser_fill refuses a select so its documented error survives", () => {
    const res = runFill(select(), "India", AS_FILL);
    assert.equal(res["ok"], false);
    assert.equal(res["kind"], "select");
  });

  test("browser_fill_form matches an option by visible label", () => {
    const el = select();
    const res = runFill(el, "India", AS_FILL_FORM);
    assert.equal(res["ok"], true);
    assert.equal(el.value, "in");
    assert.equal(res["text"], "India");
  });

  test("browser_fill_form reports the option list when nothing matches", () => {
    const res = runFill(select(), "Atlantis", AS_FILL_FORM);
    assert.equal(res["ok"], false);
    assert.equal(Array.isArray(res["options"]), true);
  });
});

describe("fill engine — contenteditable", () => {
  test("drives rich-text editors through execCommand", () => {
    execCommandCalls = [];
    execCommandWorks = true;
    const el = new FakeHTMLElement();
    el.isContentEditable = true;
    const res = runFill(el, "typed into ProseMirror", AS_FILL_FORM);
    assert.equal(res["ok"], true);
    assert.deepEqual(execCommandCalls, [{ command: "insertText", value: "typed into ProseMirror" }]);
  });

  test("falls back to textContent when execCommand is unavailable", () => {
    execCommandCalls = [];
    execCommandWorks = false;
    const el = new FakeHTMLElement();
    el.isContentEditable = true;
    const res = runFill(el, "plain", AS_FILL);
    assert.equal(res["ok"], true);
    assert.equal(el.textContent, "plain");
    assert.deepEqual(el.fired, ["input"]);
  });
});

describe("fill engine — focus behaviour is per tool", () => {
  test("browser_fill does not move focus", () => {
    const el = textInput();
    runFill(el, "x", AS_FILL);
    assert.equal(el.focused, false);
  });

  test("browser_fill_form focuses the field first", () => {
    const el = textInput();
    runFill(el, "x", AS_FILL_FORM);
    assert.equal(el.focused, true);
  });
});

describe("fill engine — unfillable elements", () => {
  test("a plain div is refused", () => {
    const res = runFill(new FakeHTMLElement(), "x", AS_FILL);
    assert.equal(res["ok"], false);
    assert.match(String(res["reason"]), /not a fillable field/);
  });
});
