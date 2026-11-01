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

  test("SC17: a task holding a browser_execute_js after which a dialog \"Saved\" appeared is refused with an error naming browser_execute_js", () => {
    const r = compileSteps([
      entry({ tool: "browser_navigate" }),
      entry({ tool: "browser_execute_js", replayable: false, change: { appeared: [{ role: "dialog", name: "Saved" }] } }),
    ]);

    assert.ok(!r.success);
    assert.match(r.error, /browser_execute_js/);
  });

  test("SC77: a browser_execute_js journaled readOnly is left out, and the two clicks around it compile", () => {
    const r = compileSteps([
      entry({ tool: "browser_click", locator: { role: "link", name: "Reports", nth: 0 } }),
      entry({ tool: "browser_execute_js", replayable: false, readOnly: true, change: { appeared: [{ role: "link", name: "Docs" }] } }),
      entry({ tool: "browser_click", locator: { role: "button", name: "Export", nth: 0 } }),
    ]);

    assert.deepEqual(okSteps(r).map((s) => s.locator), [
      { role: "link", name: "Reports", nth: 0 },
      { role: "button", name: "Export", nth: 0 },
    ]);
  });

  test("SC78: a browser_execute_js not journaled readOnly is refused even when nothing appeared, since it may have set a value", () => {
    const r = compileSteps([entry({ tool: "browser_execute_js", replayable: false, change: { appeared: [] } })]);

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

  test("SC84: a new tab that landed on https://github.com/nodejs/node expects only that URL, not the header links that came with the page", () => {
    const steps = okSteps(
      compileSteps([
        entry({
          tool: "browser_new_tab",
          args: { url: "https://github.com/nodejs/node" },
          url: "https://b.test/",
          change: { url: "https://github.com/nodejs/node", appeared: [{ role: "link", name: "Homepage (g then d)" }, { role: "button", name: "Open menu" }] },
        }),
      ]),
    );

    assert.deepEqual(steps[0]?.expect, { url: "https://github.com/nodejs/node" });
  });

  test("SC85: a click that moved the page to https://b.test/releases expects that URL alone, not the elements of the new page", () => {
    const steps = okSteps(
      compileSteps([
        entry({
          tool: "browser_click",
          locator: { role: "link", name: "Releases", nth: 0 },
          change: { url: "https://b.test/releases", appeared: [{ role: "link", name: "Skip to content" }] },
        }),
      ]),
    );

    assert.deepEqual(steps[0]?.expect, { url: "https://b.test/releases" });
  });

  test("SC86: a click after which status \"Saved\" and button \"Undo\" appeared expects the status alone", () => {
    const steps = okSteps(
      compileSteps([
        entry({
          tool: "browser_click",
          locator: { role: "button", name: "Save", nth: 0 },
          change: { appeared: [{ role: "status", name: "Saved" }, { role: "button", name: "Undo" }] },
        }),
      ]),
    );

    assert.deepEqual(steps[0]?.expect, { appeared: [{ role: "status", name: "Saved" }] });
  });

  test("SC87: a click that only opened a menu, with no URL change, message, dialog or download, expects the menu items it showed", () => {
    const steps = okSteps(
      compileSteps([
        entry({
          tool: "browser_click",
          locator: { role: "button", name: "Actions", nth: 0 },
          change: { appeared: [{ role: "menuitem", name: "Rename" }, { role: "menuitem", name: "Delete" }] },
        }),
      ]),
    );

    assert.deepEqual(steps[0]?.expect, { appeared: [{ role: "menuitem", name: "Rename" }, { role: "menuitem", name: "Delete" }] });
  });

  test("SC92: a task that opened a tab, clicked, then closed that tab compiles the close as a close_tab step with no args", () => {
    const steps = okSteps(
      compileSteps([
        entry({ tool: "browser_new_tab", args: { url: "https://b.test/" } }),
        entry({ tool: "browser_click", locator: { role: "link", name: "Reports", nth: 0 } }),
        entry({ tool: "browser_close_tab" }),
      ]),
    );

    assert.deepEqual(steps.at(-1), { action: "close_tab", args: {} });
  });

  test("SC93: a task that closes the current tab without having opened one is refused, since replay would close the user's tab", () => {
    const r = compileSteps([entry({ tool: "browser_click", locator: { role: "link", name: "Reports", nth: 0 } }), entry({ tool: "browser_close_tab" })]);

    assert.ok(!r.success);
    assert.match(r.error, /close.*did not open/);
  });

  test("SC106: a wait_for_load during which the latest release's link appeared, and a wait_for, carry no expectation: a wait causes nothing", () => {
    const steps = okSteps(
      compileSteps([
        entry({ tool: "browser_wait_for_load", change: { appeared: [{ role: "link", name: "2026-10-28, Version 26.13.0 'Lithium' (LTS)" }] } }),
        entry({ tool: "browser_wait_for", args: { selector: "#month" }, change: { appeared: [{ role: "combobox", name: "Month" }] } }),
      ]),
    );

    assert.deepEqual(steps.map((s) => s.expect), [undefined, undefined]);
  });

  test("SC64: a browser_download pointing Chrome's downloads at /tmp/x between two clicks compiles to just the two clicks", () => {
    const steps = okSteps(
      compileSteps([
        entry({ tool: "browser_click", locator: { role: "button", name: "Reports", nth: 0 } }),
        entry({ tool: "browser_download", args: { downloadPath: "/tmp/x" } }),
        entry({ tool: "browser_click", locator: { role: "button", name: "Export CSV", nth: 0 } }),
      ]),
    );

    assert.deepEqual(
      steps.map((s) => s.action),
      ["click", "click"],
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

  test("SC99: topic=Alan Turing becomes {{topic|underscore}} in /wiki/Alan_Turing, {{topic|plus}} in q=Alan+Turing and {{topic|url}} in s=Alan%20Turing", () => {
    const r = applyParams(
      [
        { action: "type", args: { text: "Alan Turing" } },
        { action: "click", args: {}, locator: { role: "button", name: "Search", nth: 0 }, expect: { url: "https://w.test/wiki/Alan_Turing" } },
        { action: "navigate", args: { url: "https://w.test/find?q=Alan+Turing&s=Alan%20Turing" } },
      ],
      { topic: "Alan Turing" },
    );

    assert.ok(r.success, r.success ? "" : r.error);
    assert.equal(r.data[0]?.args["text"], "{{topic}}");
    assert.equal(r.data[1]?.expect?.url, "https://w.test/wiki/{{topic|underscore}}");
    assert.equal(r.data[2]?.args["url"], "https://w.test/find?q={{topic|plus}}&s={{topic|url}}");
  });

  test("SC74: param repo=nodejs/node becomes {{repo}} in a new tab's expected URL and in an expected element's name, not only in its args", () => {
    const r = applyParams(
      [
        {
          action: "new_tab",
          args: { url: "https://github.com/nodejs/node" },
          expect: { url: "https://github.com/nodejs/node", appeared: [{ role: "heading", name: "nodejs/node" }] },
        },
      ],
      { repo: "nodejs/node" },
    );

    assert.ok(r.success, r.success ? "" : r.error);
    assert.deepEqual(r.data[0]?.expect, { url: "https://github.com/{{repo}}", appeared: [{ role: "heading", name: "{{repo}}" }] });
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
