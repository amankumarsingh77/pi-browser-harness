import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type JournalEntry, type NewEntry, activeJournal, createJournal, setActiveJournal } from "../../src/recipes/journal";
import { type Recipe, type RecipeStep, parseRecipe } from "../../src/recipes/recipe";
import { repairSteps, saveRecipeTool } from "../../src/recipes/save-tool";
import { recipeRoots, saveRecipe } from "../../src/recipes/store";
import type { TabInfo } from "../../src/cdp/types";
import { ok } from "../../src/util/result";
import { axNode, createFakeClient } from "../domains/fake-client";
import { pageInfoOf, withClient } from "../domains/client-overrides";
import { fakeCtx, fakePi } from "../helpers/fake-pi";

type SaveCall = {
  readonly confirms: ReadonlyArray<boolean>;
  readonly args: Readonly<Record<string, unknown>>;
  readonly cwd?: string;
  // The buttons on billing.test's invoices page, which a repair's check replays against.
  readonly buttons?: ReadonlyArray<string>;
};

const resultText = (r: { readonly content: ReadonlyArray<{ readonly type: string }> }): string =>
  r.content.flatMap((c) => ("text" in c && typeof c.text === "string" ? [c.text] : [])).join("");

const ONE_TAB: ReadonlyArray<TabInfo> = [{ targetId: "t1", title: "Invoices", url: "https://billing.test/invoices", owned: true }];
const BOX = ok({ model: { content: [100, 200, 140, 200, 140, 220, 100, 220], width: 40, height: 20 } });

const pageWith = (buttons: ReadonlyArray<string>) =>
  ok({
    nodes: [
      axNode("1", "RootWebArea", "", { childIds: buttons.map((_, i) => String(i + 2)) }),
      ...buttons.map((name, i) => axNode(String(i + 2), "button", name, { parentId: "1", backendDOMNodeId: 50 + i })),
    ],
  });

describe("browser_save_recipe", () => {
  let agentDir: string;
  let savedAgentDir: string | undefined;

  beforeEach(async () => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-save-recipe-test-"));
    savedAgentDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    const journal = createJournal(join(agentDir, "journal"), "s-1");
    await journal.beginRun();
    const base: Pick<NewEntry, "source" | "replayable" | "password" | "ok"> = { source: "agent", replayable: true, password: false, ok: true };
    await journal.append({ ...base, tool: "browser_navigate", args: { url: "https://billing.test/invoices" }, url: "about:blank" });
    await journal.append({
      ...base,
      tool: "browser_select_option",
      args: { label: "2026-09" },
      locator: { role: "combobox", name: "Period", nth: 0 },
      url: "https://billing.test/invoices",
    });
    await journal.append({
      ...base,
      tool: "browser_click",
      args: {},
      locator: { role: "button", name: "Export CSV", nth: 0 },
      url: "https://billing.test/invoices",
    });
    setActiveJournal(journal);
  });

  afterEach(() => {
    setActiveJournal(undefined);
    if (savedAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
    else process.env["PI_CODING_AGENT_DIR"] = savedAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  const save = async (call: SaveCall) => {
    const pi = fakePi();
    const browser = await createFakeClient({
      canned: { "Accessibility.getFullAXTree": pageWith(call.buttons ?? []), "DOM.getBoxModel": BOX, "Page.navigate": ok({ frameId: "f1" }) },
      evaluate: () => ok(false),
    });
    const client = withClient(browser.client, {
      listTabs: () => Promise.resolve(ok(ONE_TAB)),
      pageInfo: () => Promise.resolve(pageInfoOf({ url: "https://billing.test/invoices" })),
    });
    saveRecipeTool.register(pi.pi, client);
    const fake = fakeCtx({ confirms: call.confirms, sessionId: "s-1", ...(call.cwd !== undefined ? { cwd: call.cwd } : {}) });
    const run = pi.tool("browser_save_recipe").execute("call-1", call.args, undefined, undefined, fake.ctx);
    return { fake, run };
  };


  const userFile = (): string => join(agentDir, "browser-recipes", "billing.test", "vendor-invoices.yaml");

  test("SC22: saving vendor-invoices with month=2026-09 shows the YAML with {{month}} once, then writes a 3-step version-1 file the tool names", async () => {
    const { fake, run } = await save({ confirms: [true], args: { name: "vendor-invoices", params: { month: "2026-09" } } });
    const result = await run;

    assert.equal(fake.confirmations.length, 1);
    assert.match(fake.confirmations[0]?.message ?? "", /\{\{month\}\}/);
    const parsed = parseRecipe(readFileSync(userFile(), "utf8"));
    assert.ok(parsed.success, parsed.success ? "" : parsed.error);
    assert.equal(parsed.data.version, 1);
    assert.equal(parsed.data.steps.length, 3);
    assert.match(resultText(result), new RegExp(userFile().replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  });

  test("SC80: a save after a readOnly browser_execute_js writes the 3 steps and says one call was left out", async () => {
    await activeJournal()?.append({ source: "agent", replayable: false, password: false, ok: true, tool: "browser_execute_js", args: {}, url: "https://billing.test/invoices", readOnly: true });

    const result = await (await save({ confirms: [true], args: { name: "vendor-invoices", params: { month: "2026-09" } } })).run;

    const parsed = parseRecipe(readFileSync(userFile(), "utf8"));
    assert.ok(parsed.success, parsed.success ? "" : parsed.error);
    assert.equal(parsed.data.steps.length, 3);
    assert.match(resultText(result), /Left out 1 browser_execute_js call that changed nothing/);
  });

  test("SC23: when the user declines the confirm, the tool fails saying so and no recipe file is written", async () => {
    const { run } = await save({ confirms: [false], args: { name: "vendor-invoices", params: { month: "2026-09" } } });

    await assert.rejects(run, /declined/);
    assert.equal(existsSync(join(agentDir, "browser-recipes")), false);
  });

  test("SC24: saving vendor-invoices a second time writes version 2 and keeps version 1's content under .history", async () => {
    await (await save({ confirms: [true], args: { name: "vendor-invoices", params: { month: "2026-09" } } })).run;
    const first = readFileSync(userFile(), "utf8");

    await (await save({ confirms: [true], args: { name: "vendor-invoices", params: { month: "2026-09" } } })).run;

    const second = parseRecipe(readFileSync(userFile(), "utf8"));
    assert.ok(second.success, second.success ? "" : second.error);
    assert.equal(second.data.version, 2);
    assert.equal(readFileSync(join(agentDir, "browser-recipes", "billing.test", ".history", "vendor-invoices.v1.yaml"), "utf8"), first);
  });

  test("SC25: with project: true the recipe lands at <cwd>/.pi/browser-recipes/billing.test/vendor-invoices.yaml", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-save-recipe-project-"));
    try {
      await (await save({ confirms: [true], args: { name: "vendor-invoices", params: { month: "2026-09" }, project: true }, cwd })).run;

      assert.equal(existsSync(join(cwd, ".pi", "browser-recipes", "billing.test", "vendor-invoices.yaml")), true);
      assert.equal(existsSync(userFile()), false);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });

  test("SC46: repairing vendor-invoices v1 from step 2 after a failure marker and one agent click is confirmed, written as v2 with the new step 2 and last_run.repaired_step 2, and keeps v1 under .history", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "pi-save-recipe-repair-"));
    try {
      await saveRecipe(recipeRoots(cwd).user, {
        name: "vendor-invoices",
        site: "billing.test",
        version: 1,
        params: { month: { type: "string", example: "2026-09" } },
        steps: [
          { action: "navigate", args: { url: "https://billing.test/invoices?m={{month}}" } },
          { action: "click", args: {}, locator: { role: "button", name: "Export CSV", nth: 0 } },
        ],
        recorded: { at: "2026-10-01T00:00:00.000Z", session: "s-rec" },
      });
      const journal = activeJournal();
      assert.ok(journal !== undefined);
      await journal.append({ source: "replay", tool: "browser_run_recipe", replayable: false, args: { month: "2026-10" }, password: false, url: "https://billing.test/invoices", ok: false, recipe: { name: "vendor-invoices", step: 2 } });
      await journal.append({ source: "agent", tool: "browser_click", replayable: true, args: {}, locator: { role: "button", name: "Download CSV", nth: 0 }, password: false, url: "https://billing.test/invoices", ok: true });

      const { fake, run } = await save({ confirms: [true], args: { name: "vendor-invoices", repair_step: 2 }, cwd, buttons: ["Download CSV"] });
      const result = await run;

      assert.equal(fake.confirmations.length, 1);
      assert.match(resultText(result), /Checked: a replay of all 2 steps passed/);
      const repaired = parseRecipe(readFileSync(userFile(), "utf8"));
      assert.ok(repaired.success, repaired.success ? "" : repaired.error);
      assert.equal(repaired.data.version, 2);
      assert.deepEqual(repaired.data.steps[1]?.locator, { role: "button", name: "Download CSV", nth: 0 });
      assert.equal(repaired.data.lastRun?.repairedStep, 2);
      assert.equal(existsSync(join(agentDir, "browser-recipes", "billing.test", ".history", "vendor-invoices.v1.yaml")), true);
    } finally {
      rmSync(cwd, { recursive: true, force: true });
    }
  });
});

describe("browser_save_recipe repair check", () => {
  let agentDir: string;
  let cwd: string;
  let savedAgentDir: string | undefined;

  const steps: ReadonlyArray<RecipeStep> = [
    { action: "navigate", args: { url: "https://billing.test/invoices?m={{month}}" } },
    { action: "click", args: {}, locator: { role: "button", name: "Export CSV", nth: 0 } },
  ];

  beforeEach(async () => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-repair-check-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "pi-repair-check-cwd-"));
    savedAgentDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
    const journal = createJournal(join(agentDir, "journal"), "s-1");
    await journal.beginRun();
    setActiveJournal(journal);
    await saveRecipe(recipeRoots(cwd).user, {
      name: "vendor-invoices",
      site: "billing.test",
      version: 1,
      params: { month: { type: "string", example: "2026-09" } },
      steps,
      recorded: { at: "2026-10-01T00:00:00.000Z", session: "s-rec" },
    });
    await journal.append({ source: "replay", tool: "browser_run_recipe", replayable: false, args: { month: "2026-10" }, password: false, url: "https://billing.test/invoices", ok: false, recipe: { name: "vendor-invoices", step: 2 } });
  });

  afterEach(() => {
    setActiveJournal(undefined);
    if (savedAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
    else process.env["PI_CODING_AGENT_DIR"] = savedAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  const repairCall = async (confirms: ReadonlyArray<boolean>, buttons: ReadonlyArray<string>) => {
    const pi = fakePi();
    const fake = await createFakeClient({
      canned: { "Accessibility.getFullAXTree": pageWith(buttons), "DOM.getBoxModel": BOX, "Page.navigate": ok({ frameId: "f1" }) },
      evaluate: () => ok(false),
    });
    const client = withClient(fake.client, {
      listTabs: () => Promise.resolve(ok(ONE_TAB)),
      pageInfo: () => Promise.resolve(pageInfoOf({ url: "https://billing.test/invoices" })),
    });
    saveRecipeTool.register(pi.pi, client);
    const ctx = fakeCtx({ confirms, sessionId: "s-1", cwd });
    const run = pi.tool("browser_save_recipe").execute("call-1", { name: "vendor-invoices", repair_step: 2 }, undefined, undefined, ctx.ctx);
    return { ctx, run };
  };

  const repair = async (confirms: ReadonlyArray<boolean>, buttons: ReadonlyArray<string>) => {
    const { ctx, run } = await repairCall(confirms, buttons);
    return { ctx, result: await run };
  };

  const fileText = (): string => readFileSync(join(agentDir, "browser-recipes", "billing.test", "vendor-invoices.yaml"), "utf8");

  test("SC95: a repair whose steps fail on replay, because the clicked \"Download CSV\" is not on the page, is not written and says to run the recipe again", async () => {
    await activeJournal()?.append({ source: "agent", tool: "browser_click", replayable: true, args: {}, locator: { role: "button", name: "Download CSV", nth: 0 }, password: false, url: "https://billing.test/invoices", ok: true });
    const before = (await activeJournal()?.entries())?.length;

    const { run } = await repairCall([true], ["Export CSV"]);

    await assert.rejects(run, /stopped at step 2.*Download CSV.*browser_run_recipe/s);
    assert.match(fileText(), /version: 1/);
    assert.equal((await activeJournal()?.entries())?.length, before, "the check must not add a failure marker the next repair would start from");
  });

  test("SC96: a repair whose new step starts a download asks before the check, and No saves it unchecked, saying so", async () => {
    await activeJournal()?.append({
      source: "agent", tool: "browser_click", replayable: true, args: {}, locator: { role: "button", name: "Download CSV", nth: 0 }, password: false,
      url: "https://billing.test/invoices", ok: true, change: { appeared: [], download: true },
    });

    const { ctx, result } = await repair([false, true], ["Download CSV"]);

    assert.match(ctx.confirmations[0]?.message ?? "", /step 2: click button "Download CSV" \(starts a download\)/);
    assert.match(fileText(), /version: 2/);
    assert.match(resultText(result), /Not checked by a replay/);
  });

  test("SC97: a click that sent a POST while it was recorded is saved with writes: true, and a repair holding it asks before the check", async () => {
    await activeJournal()?.append({
      source: "agent", tool: "browser_click", replayable: true, args: {}, locator: { role: "button", name: "Download CSV", nth: 0 }, password: false,
      url: "https://billing.test/invoices", ok: true, wrote: true,
    });

    const { ctx } = await repair([false, true], ["Download CSV"]);

    assert.match(ctx.confirmations[0]?.message ?? "", /step 2: click button "Download CSV" \(sends data to the site\)/);
    assert.match(fileText(), /writes: true/);
  });
});

describe("repairSteps", () => {
  const entry = (over: Partial<JournalEntry> & Pick<JournalEntry, "tool">): JournalEntry => ({
    v: 1,
    at: "2026-10-01T00:00:00.000Z",
    run: 2,
    source: "agent",
    replayable: true,
    args: {},
    password: false,
    url: "https://billing.test/invoices",
    ok: true,
    ...over,
  });
  const failedAt = (step: number, args: JournalEntry["args"] = { month: "2026-10" }): JournalEntry =>
    entry({ tool: "browser_run_recipe", source: "replay", replayable: false, ok: false, args, recipe: { name: "vendor-invoices", step } });
  const click = (role: string, name: string): RecipeStep => ({ action: "click", args: {}, locator: { role, name, nth: 0 } });
  const FOUR_STEPS: ReadonlyArray<RecipeStep> = [
    { action: "navigate", args: { url: "https://billing.test/invoices?m={{month}}" } },
    { action: "select_option", args: { label: "{{month}}" }, locator: { role: "combobox", name: "Period", nth: 0 } },
    click("button", "Export CSV"),
    click("button", "Close"),
  ];
  const recipe: Recipe = {
    name: "vendor-invoices",
    site: "billing.test",
    version: 1,
    params: { month: { type: "string", example: "2026-09" } },
    steps: FOUR_STEPS,
    recorded: { at: "2026-10-01T00:00:00.000Z", session: "s-rec" },
  };
  const agentClick = (name: string): JournalEntry => entry({ tool: "browser_click", locator: { role: "button", name, nth: 0 } });

  test("SC79: a repair whose agent read the page with a readOnly browser_execute_js keeps only the click", () => {
    const read = entry({ tool: "browser_execute_js", replayable: false, readOnly: true });
    const r = repairSteps(recipe, [failedAt(3), read, agentClick("Download CSV")], 3);

    assert.ok(r.success, r.success ? "" : r.error);
    assert.deepEqual(r.data.steps.slice(2), [click("button", "Download CSV")]);
  });

  test("SC43: with a failure marker at step 3 followed by clicks on Download CSV and Close, steps 1-2 stay and the two clicks replace steps 3-4", () => {
    const r = repairSteps(recipe, [failedAt(3), agentClick("Download CSV"), agentClick("Close")], 3);

    assert.ok(r.success, r.success ? "" : r.error);
    assert.deepEqual(r.data.steps, [FOUR_STEPS[0], FOUR_STEPS[1], click("button", "Download CSV"), click("button", "Close")]);
  });

  test("SC44: repairing step 2 when the last failure marker is at step 3 fails saying the replay stopped at step 3", () => {
    const r = repairSteps(recipe, [failedAt(3), agentClick("Download CSV")], 2);

    assert.ok(!r.success, "expected the repair to be refused");
    assert.match(r.error, /stopped at step 3, not 2/);
  });

  test("SC45: a run with month=2026-10 whose repair selected label 2026-10 templates the label back to {{month}}", () => {
    const selected = entry({ tool: "browser_select_option", args: { label: "2026-10" }, locator: { role: "combobox", name: "Period", nth: 0 } });

    const r = repairSteps(recipe, [failedAt(2), selected, agentClick("Export CSV")], 2);

    assert.ok(r.success, r.success ? "" : r.error);
    assert.deepEqual(r.data.steps[1]?.args, { label: "{{month}}" });
  });

  test("SC65: a repair that set Chrome's downloads to /tmp/x before clicking Download CSV keeps only the click, not the download folder", () => {
    const download = entry({ tool: "browser_download", args: { downloadPath: "/tmp/x" } });

    const r = repairSteps(recipe, [failedAt(3), download, agentClick("Download CSV")], 3);

    assert.ok(r.success, r.success ? "" : r.error);
    assert.deepEqual(r.data.steps, [FOUR_STEPS[0], FOUR_STEPS[1], click("button", "Download CSV")]);
  });
});
