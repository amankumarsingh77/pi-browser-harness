import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TabInfo } from "../../src/cdp/types";
import type { Recipe } from "../../src/recipes/recipe";
import { runRecipeTool } from "../../src/recipes/run-tool";
import { recipeRoots, saveRecipe } from "../../src/recipes/store";
import { ok } from "../../src/util/result";
import { sleep } from "../../src/util/sleep";
import { defineBrowserTool } from "../../src/util/tool";
import { createFakeClient } from "../domains/fake-client";
import { pageInfoOf, withClient } from "../domains/client-overrides";
import { fakeCtx, fakePi } from "../helpers/fake-pi";

const ONE_TAB: ReadonlyArray<TabInfo> = [{ targetId: "t1", title: "Fake", url: "https://billing.test/", owned: true }];

const recipeOf = (name: string, site: string, steps: Recipe["steps"]): Recipe => ({
  name,
  site,
  version: 1,
  params: { month: { type: "string", example: "2026-09" } },
  steps,
  recorded: { at: "2026-10-01T00:00:00.000Z", session: "s-rec" },
});

const NAVIGATE_ONLY: Recipe["steps"] = [{ action: "navigate", args: { url: "https://billing.test/invoices?m={{month}}" } }];

const navigatingClient = async () => {
  const fake = await createFakeClient({ canned: { "Page.navigate": ok({ frameId: "f1" }) } });
  const client = withClient(fake.client, {
    listTabs: () => Promise.resolve(ok(ONE_TAB)),
    pageInfo: () => Promise.resolve(pageInfoOf({ url: "https://billing.test/invoices" })),
  });
  return { fake, client };
};

const textOf = (r: { readonly content: ReadonlyArray<{ readonly type: string }> }): string =>
  r.content.flatMap((c) => ("text" in c && typeof c.text === "string" ? [c.text] : [])).join("");

describe("browser_run_recipe", () => {
  let agentDir: string;
  let cwd: string;
  let savedAgentDir: string | undefined;

  beforeEach(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-run-recipe-agent-"));
    cwd = mkdtempSync(join(tmpdir(), "pi-run-recipe-cwd-"));
    savedAgentDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
  });

  afterEach(() => {
    if (savedAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
    else process.env["PI_CODING_AGENT_DIR"] = savedAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
    rmSync(cwd, { recursive: true, force: true });
  });

  test("SC29: running vendor-invoices with no params is refused naming month (e.g. 2026-09), before any CDP call", async () => {
    await saveRecipe(recipeRoots(cwd).project, recipeOf("vendor-invoices", "billing.test", NAVIGATE_ONLY));
    const fake = await createFakeClient();

    const r = await runRecipeTool.handler(
      { name: "vendor-invoices" },
      { client: fake.client, signal: undefined, onUpdate: () => undefined, extensionCtx: fakeCtx({ cwd }).ctx },
    );

    assert.ok(!r.success, "expected the run to be refused");
    assert.match(r.error.message, /month \(e\.g\. 2026-09\)/);
    assert.equal(fake.calls.length, 0);
  });

  test("SC35: a replay started while a serialized tool holds the mutation mutex runs its first step only after the release, and completes", async () => {
    await saveRecipe(recipeRoots(cwd).project, recipeOf("vendor-invoices", "billing.test", NAVIGATE_ONLY));
    const { fake, client } = await navigatingClient();
    const pi = fakePi();
    // The daemon-socket gate is not under test; the parallel lane and the per-step mutex are.
    defineBrowserTool({ ...runRecipeTool, ensureAlive: false }).register(pi.pi, client);
    // What runHandler does for a serialized tool for as long as it runs.
    const release = await client.mutationMutex().acquire();

    const run = pi.tool("browser_run_recipe").execute("call-1", { name: "vendor-invoices", params: { month: "2026-10" } }, undefined, undefined, fakeCtx({ cwd }).ctx);
    await sleep(100);
    const navigatesWhileHeld = fake.callsTo("Page.navigate").length;
    release();
    const result = await run;

    assert.equal(navigatesWhileHeld, 0);
    assert.equal(fake.callsTo("Page.navigate").length, 1);
    assert.equal(textOf(result), "Recipe vendor-invoices ran 1 steps successfully.");
  });

  test("SC36: with no name it lists a project recipe and a user recipe with site, step count and month (e.g. 2026-09)", async () => {
    const roots = recipeRoots(cwd);
    await saveRecipe(roots.project, recipeOf("vendor-invoices", "billing.test", NAVIGATE_ONLY));
    await saveRecipe(roots.user, recipeOf("payroll-export", "payroll.test", [...NAVIGATE_ONLY, ...NAVIGATE_ONLY]));
    const fake = await createFakeClient();

    const r = await runRecipeTool.handler({}, { client: fake.client, signal: undefined, onUpdate: () => undefined, extensionCtx: fakeCtx({ cwd }).ctx });

    assert.ok(r.success);
    assert.match(r.data.text, /vendor-invoices — billing\.test, 1 steps, v1, params: month \(e\.g\. 2026-09\)/);
    assert.match(r.data.text, /payroll-export — payroll\.test, 2 steps, v1, params: month \(e\.g\. 2026-09\)/);
  });
});
