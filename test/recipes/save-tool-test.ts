import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type NewEntry, createJournal, setActiveJournal } from "../../src/recipes/journal";
import { parseRecipe } from "../../src/recipes/recipe";
import { saveRecipeTool } from "../../src/recipes/save-tool";
import { createFakeClient } from "../domains/fake-client";
import { fakeCtx, fakePi } from "../helpers/fake-pi";

type SaveCall = { readonly confirms: ReadonlyArray<boolean>; readonly args: Readonly<Record<string, unknown>>; readonly cwd?: string };

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
    saveRecipeTool.register(pi.pi, (await createFakeClient()).client);
    const fake = fakeCtx({ confirms: call.confirms, sessionId: "s-1", ...(call.cwd !== undefined ? { cwd: call.cwd } : {}) });
    const run = pi.tool("browser_save_recipe").execute("call-1", call.args, undefined, undefined, fake.ctx);
    return { fake, run };
  };

  const resultText = (r: { readonly content: ReadonlyArray<{ readonly type: string }> }): string =>
    r.content.flatMap((c) => ("text" in c && typeof c.text === "string" ? [c.text] : [])).join("");

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
});
