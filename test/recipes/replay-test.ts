import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserClient } from "../../src/client";
import type { CdpSession } from "../../src/cdp/session";
import type { TabInfo } from "../../src/cdp/types";
import { type Journal, createJournal, setActiveJournal } from "../../src/recipes/journal";
import type { Recipe, RecipeStep } from "../../src/recipes/recipe";
import { runRecipe } from "../../src/recipes/replay";
import { ok } from "../../src/util/result";
import { type FakeClient, axNode, createFakeClient, evaluated } from "../domains/fake-client";
import { pageInfoOf, withClient } from "../domains/client-overrides";
import { fakeCtx } from "../helpers/fake-pi";

const ONE_TAB: ReadonlyArray<TabInfo> = [{ targetId: "t1", title: "Fake", url: "https://billing.test/", owned: true }];
const BOX_40x20_AT_100x200 = ok({ model: { content: [100, 200, 140, 200, 140, 220, 100, 220], width: 40, height: 20 } });

const tree = (...nodes: ReadonlyArray<{ readonly role: string; readonly name: string; readonly backendId: number }>) =>
  ok({
    nodes: [
      axNode("1", "RootWebArea", "", { childIds: nodes.map((_, i) => String(i + 2)) }),
      ...nodes.map((n, i) => axNode(String(i + 2), n.role, n.name, { parentId: "1", backendDOMNodeId: n.backendId })),
    ],
  });

const EXPORT_PAGE = tree({ role: "combobox", name: "Period", backendId: 51 }, { role: "button", name: "Export CSV", backendId: 52 });

const recipeOf = (steps: ReadonlyArray<RecipeStep>): Recipe => ({
  name: "vendor-invoices",
  site: "billing.test",
  version: 1,
  params: { month: { type: "string", example: "2026-09" } },
  steps,
  recorded: { at: "2026-10-01T00:00:00.000Z", session: "s-rec" },
});

const clickExport = (expect?: RecipeStep["expect"]): RecipeStep => ({
  action: "click",
  args: {},
  locator: { role: "button", name: "Export CSV", nth: 0 },
  ...(expect !== undefined ? { expect } : {}),
});

// A page whose live status messages are whatever `messages` holds; every other page script reads as false.
const clientFor = async (opts: { readonly messages?: ReadonlyArray<{ readonly role: string; readonly name: string }> } = {}): Promise<{ readonly fake: FakeClient; readonly client: BrowserClient }> => {
  const fake = await createFakeClient({
    canned: {
      "Accessibility.getFullAXTree": EXPORT_PAGE,
      "DOM.getBoxModel": BOX_40x20_AT_100x200,
      "DOM.resolveNode": ok({ object: { type: "object", objectId: "o1" } }),
      "Runtime.callFunctionOn": evaluated({ status: "ok", value: "2026-10", label: "2026-10" }),
      "Page.navigate": ok({ frameId: "f1" }),
    },
    evaluate: (expression) => ok(expression.includes("liveMessages") ? (opts.messages ?? []) : false),
  });
  const client = withClient(fake.client, {
    listTabs: () => Promise.resolve(ok(ONE_TAB)),
    pageInfo: () => Promise.resolve(pageInfoOf({ url: "https://billing.test/invoices" })),
  });
  return { fake, client };
};

// The session as the tools see it, except that releasing the mouse also starts a download on the tab.
const downloadingOnClick = (fake: FakeClient): CdpSession => ({
  ...fake.session,
  call: (method, ...args) => {
    const sent = fake.session.call(method, ...args);
    const [params] = args;
    if (method === "Input.dispatchMouseEvent" && params !== undefined && "type" in params && params.type === "mouseReleased") {
      fake.emit({ method: "Page.downloadWillBegin", sessionId: "s1", params: { guid: "g1", url: "https://billing.test/x.csv", suggestedFilename: "x.csv" } });
    }
    return sent;
  },
});

describe("recipe replay", () => {
  let dir: string;
  let journal: Journal;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-replay-test-"));
    journal = createJournal(dir, "s-replay");
    setActiveJournal(journal);
  });

  afterEach(() => {
    setActiveJournal(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  test("SC31: navigate, select {{month}} on combobox \"Period\" and click button \"Export CSV\" run through the tools with month=2026-10 and journal three replay entries", async () => {
    const { fake, client } = await clientFor();
    const recipe = recipeOf([
      { action: "navigate", args: { url: "https://billing.test/invoices?m={{month}}" } },
      { action: "select_option", args: { label: "{{month}}" }, locator: { role: "combobox", name: "Period", nth: 0 } },
      clickExport(),
    ]);

    const outcome = await runRecipe({ client, extensionCtx: fakeCtx().ctx, recipe, params: { month: "2026-10" } });

    assert.deepEqual(outcome, { ok: true, steps: 3 });
    assert.equal(fake.callsTo("Page.navigate")[0]?.params["url"], "https://billing.test/invoices?m=2026-10");
    const selected = fake.callsTo("Runtime.callFunctionOn")[0]?.params["arguments"];
    assert.deepEqual(selected, [{ value: { wv: null, wl: "2026-10", wi: null } }]);
    assert.deepEqual(fake.callsTo("DOM.getBoxModel").map((c) => c.params["backendNodeId"]), [52]);
    const pressed = fake.callsTo("Input.dispatchMouseEvent").find((c) => c.params["type"] === "mousePressed");
    assert.deepEqual([pressed?.params["x"], pressed?.params["y"]], [120, 210]);
    const entries = await journal.entries();
    assert.deepEqual(
      entries.map((e) => [e.source, e.tool, e.recipe]),
      [
        ["replay", "browser_navigate", { name: "vendor-invoices", step: 1 }],
        ["replay", "browser_select_option", { name: "vendor-invoices", step: 2 }],
        ["replay", "browser_click", { name: "vendor-invoices", step: 3 }],
      ],
    );
  });

  test("SC32: step 2 expecting status \"Export complete\" that never appears fails at step 2 with the expectation, a snapshot and a journal failure marker", async () => {
    const { client } = await clientFor();
    const recipe = recipeOf([
      { action: "navigate", args: { url: "https://billing.test/invoices" } },
      clickExport({ appeared: [{ role: "status", name: "Export complete" }] }),
    ]);

    const outcome = await runRecipe({ client, extensionCtx: fakeCtx().ctx, recipe, params: { month: "2026-10" } });

    assert.ok(!outcome.ok, "expected the replay to fail");
    assert.equal(outcome.failure.step, 2);
    assert.match(outcome.failure.expected, /status "Export complete"/);
    assert.match(outcome.failure.snapshot, /button "Export CSV"/);
    const marker = (await journal.entries()).at(-1);
    assert.equal(marker?.tool, "browser_run_recipe");
    assert.equal(marker.ok, false);
    assert.deepEqual(marker.recipe, { name: "vendor-invoices", step: 2 });
  });

  test("SC33: a click expecting a download passes when Page.downloadWillBegin follows the click, and fails at that step when none does", async () => {
    const recipe = recipeOf([clickExport({ download: true })]);
    const started = await clientFor();
    const downloading = withClient(started.client, { session: () => downloadingOnClick(started.fake) });

    const passed = await runRecipe({ client: downloading, extensionCtx: fakeCtx().ctx, recipe, params: { month: "2026-10" } });
    const silent = await clientFor();
    const failed = await runRecipe({ client: silent.client, extensionCtx: fakeCtx().ctx, recipe, params: { month: "2026-10" } });

    assert.deepEqual(passed, { ok: true, steps: 1 });
    assert.ok(!failed.ok, "expected the replay without a download to fail");
    assert.equal(failed.failure.step, 1);
    assert.match(failed.failure.expected, /a download to start/);
  });

  test("SC38b: a recorded status \"Exported 42 rows\" matches a live status \"Exported 43 rows\" on replay", async () => {
    const { client } = await clientFor({ messages: [{ role: "status", name: "Exported 43 rows" }] });
    const recipe = recipeOf([clickExport({ appeared: [{ role: "status", name: "Exported 42 rows" }] })]);

    const outcome = await runRecipe({ client, extensionCtx: fakeCtx().ctx, recipe, params: { month: "2026-10" } });

    assert.deepEqual(outcome, { ok: true, steps: 1 });
  });

  test("SC38c: a recorded status \"Saved\" does not match when no status appears within 5s", async () => {
    const { client } = await clientFor({ messages: [{ role: "status", name: "Saving draft" }] });
    const recipe = recipeOf([clickExport({ appeared: [{ role: "status", name: "Saved" }] })]);

    const outcome = await runRecipe({ client, extensionCtx: fakeCtx().ctx, recipe, params: { month: "2026-10" } });

    assert.ok(!outcome.ok, "expected the replay to fail");
    assert.equal(outcome.failure.step, 1);
  });
});
