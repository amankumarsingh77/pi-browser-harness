import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { JournalEntry } from "../../src/recipes/journal";
import type { RecipeStep } from "../../src/recipes/recipe";
import { applyParams, compileSteps, latestTask, siteOf } from "../../src/recipes/compile";

const entry = (over: Partial<JournalEntry> & Pick<JournalEntry, "tool">): JournalEntry => ({
  v: 1,
  at: "2026-10-01T00:00:00.000Z",
  run: 1,
  source: "agent",
  replayable: true,
  args: {},
  password: false,
  url: "https://b.test/",
  ok: true,
  ...over,
});

const okSteps = (r: ReturnType<typeof compileSteps>): ReadonlyArray<RecipeStep> => {
  assert.ok(r.success, r.success ? "" : r.error);
  return r.data;
};

describe("latestTask", () => {
  test("SC12: with agent runs 1 and 2 and a replay-only run 3, the latest task is exactly run 2's agent entries in order", () => {
    const entries = [
      entry({ tool: "browser_navigate", run: 1 }),
      entry({ tool: "browser_click", run: 2, args: { first: true } }),
      entry({ tool: "browser_fill", run: 2, args: { value: "x" } }),
      entry({ tool: "browser_reload", run: 3, source: "replay" }),
    ];

    assert.deepEqual(latestTask(entries), [entries[1], entries[2]]);
  });
});

describe("compileSteps", () => {
  test("SC16: a task holding an entry that typed into a password field is refused because recipes never type credentials", () => {
    const r = compileSteps([entry({ tool: "browser_navigate" }), entry({ tool: "browser_fill", password: true, args: { value: "" } })]);

    assert.ok(!r.success);
    assert.match(r.error, /recipes never type credentials/);
  });

  test("SC17: a task holding a successful browser_execute_js is refused with an error naming browser_execute_js", () => {
    const r = compileSteps([entry({ tool: "browser_navigate" }), entry({ tool: "browser_execute_js", replayable: false })]);

    assert.ok(!r.success);
    assert.match(r.error, /browser_execute_js/);
  });

  test("SC18: a failed click followed by a two-field fill_form compiles to two fill steps with each field's locator and value, and no click", () => {
    const email = { role: "textbox", name: "Email", nth: 0 };
    const city = { css: "#city" };
    const steps = okSteps(
      compileSteps([
        entry({ tool: "browser_click", ok: false, error: "no such ref", locator: { role: "button", name: "Go", nth: 0 } }),
        entry({
          tool: "browser_fill_form",
          fields: [
            { locator: email, value: "a@b.test", password: false },
            { locator: city, value: "Pune", password: false },
          ],
        }),
      ]),
    );

    assert.deepEqual(steps, [
      { action: "fill", args: { value: "a@b.test" }, locator: email },
      { action: "fill", args: { value: "Pune" }, locator: city },
    ]);
  });

  test("SC19: a click located at { x: 5, y: 5 } and a drag_and_drop are flagged fragile; a role+name click is not", () => {
    const steps = okSteps(
      compileSteps([
        entry({ tool: "browser_click", locator: { x: 5, y: 5 } }),
        entry({ tool: "browser_drag_and_drop", args: { startX: 1, startY: 1, endX: 9, endY: 9 } }),
        entry({ tool: "browser_click", locator: { role: "button", name: "Save", nth: 0 } }),
      ]),
    );

    assert.deepEqual(
      steps.map((s) => s.fragile === true),
      [true, true, false],
    );
  });
});

describe("applyParams", () => {
  const steps: ReadonlyArray<RecipeStep> = [
    { action: "navigate", args: { url: "https://b.test/invoices?m=2026-09" } },
    { action: "select_option", args: { label: "2026-09" }, locator: { role: "combobox", name: "Period", nth: 0 } },
    { action: "click", args: {}, locator: { role: "link", name: "2026-09 statement", nth: 0 } },
  ];

  test("SC13: param month=2026-09 becomes {{month}} in the navigate URL, the select label and the link's name", () => {
    const r = applyParams(steps, { month: "2026-09" });

    assert.ok(r.success, r.success ? "" : r.error);
    assert.equal(r.data[0]?.args["url"], "https://b.test/invoices?m={{month}}");
    assert.equal(r.data[1]?.args["label"], "{{month}}");
    assert.deepEqual(r.data[2]?.locator, { role: "link", name: "{{month}} statement", nth: 0 });
  });

  test("SC14: param month=2031-01, which no step contains, is refused with an error naming month and 2031-01", () => {
    const r = applyParams(steps, { month: "2031-01" });

    assert.ok(!r.success);
    assert.match(r.error, /month.*2031-01/);
  });

  test("SC15: with day=2026-09-01 and month=2026-09, the value 2026-09-01 becomes {{day}}, not {{month}}-01", () => {
    const r = applyParams(
      [
        { action: "fill", args: { value: "2026-09-01" }, locator: { css: "#day" } },
        { action: "fill", args: { value: "2026-09" }, locator: { css: "#month" } },
      ],
      { month: "2026-09", day: "2026-09-01" },
    );

    assert.ok(r.success, r.success ? "" : r.error);
    assert.equal(r.data[0]?.args["value"], "{{day}}");
    assert.equal(r.data[1]?.args["value"], "{{month}}");
  });
});

describe("siteOf", () => {
  test("SC52: a task that navigated to http://../ and then sat on about:blank names no site, so it falls back to unknown-site rather than \"..\"", () => {
    const site = siteOf([entry({ tool: "browser_navigate", args: { url: "http://../" } }), entry({ tool: "browser_click", url: "about:blank" })]);

    assert.equal(site, "unknown-site");
  });

  test("SC63: a task that opens http://127.0.0.1:8765/ in a new tab from a github.com tab is on 127.0.0.1, not the previous tab's github.com", () => {
    const cases: ReadonlyArray<{ readonly name: string; readonly entries: ReadonlyArray<JournalEntry> }> = [
      { name: "new_tab with a url", entries: [entry({ tool: "browser_new_tab", url: "https://github.com/", args: { url: "http://127.0.0.1:8765/" } })] },
      {
        name: "blank new_tab, then navigate",
        entries: [
          entry({ tool: "browser_new_tab", url: "https://github.com/", change: { url: "about:blank", appeared: [] } }),
          entry({ tool: "browser_navigate", url: "about:blank", args: { url: "http://127.0.0.1:8765/" } }),
        ],
      },
    ];
    for (const c of cases) assert.equal(siteOf(c.entries), "127.0.0.1", c.name);
  });
});
