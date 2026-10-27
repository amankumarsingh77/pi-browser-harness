import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { cdpError } from "../../src/cdp/errors";
import type { TabInfo } from "../../src/cdp/types";
import { parseCommandArgs, registerRecipeCommand } from "../../src/recipes/command";
import { recipeRoots, findRecipe, saveRecipe } from "../../src/recipes/store";
import { err, ok } from "../../src/util/result";
import { createFakeClient } from "../domains/fake-client";
import { pageInfoOf, withClient } from "../domains/client-overrides";
import { fakeCtx, fakePi } from "../helpers/fake-pi";

const ONE_TAB: ReadonlyArray<TabInfo> = [{ targetId: "t1", title: "Fake", url: "https://billing.test/", owned: true }];

describe("/browser-recipe", () => {
  test("SC28: vendor-invoices month=2026-10 note=\"two words\" parses to the name and both params, the quoted one whole", () => {
    assert.deepEqual(parseCommandArgs('vendor-invoices month=2026-10 note="two words"'), {
      name: "vendor-invoices",
      params: { month: "2026-10", note: "two words" },
    });
  });

  describe("running a recipe", () => {
    let agentDir: string;
    let cwd: string;
    let savedAgentDir: string | undefined;

    beforeEach(() => {
      agentDir = mkdtempSync(join(tmpdir(), "pi-recipe-cmd-agent-"));
      cwd = mkdtempSync(join(tmpdir(), "pi-recipe-cmd-cwd-"));
      savedAgentDir = process.env["PI_CODING_AGENT_DIR"];
      process.env["PI_CODING_AGENT_DIR"] = agentDir;
    });

    afterEach(() => {
      if (savedAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
      else process.env["PI_CODING_AGENT_DIR"] = savedAgentDir;
      rmSync(agentDir, { recursive: true, force: true });
      rmSync(cwd, { recursive: true, force: true });
    });

    // vendor-invoices navigates twice; the second Page.navigate is refused, so the replay fails at step 2.
    const runFailingAtStep2 = async (opts: { readonly idle: boolean }) => {
      await saveRecipe(recipeRoots(cwd).user, {
        name: "vendor-invoices",
        site: "billing.test",
        version: 1,
        params: { month: { type: "string", example: "2026-09" } },
        steps: [
          { action: "navigate", args: { url: "https://billing.test/invoices?m={{month}}" } },
          { action: "navigate", args: { url: "https://billing.test/export?m={{month}}" } },
        ],
        recorded: { at: "2026-10-01T00:00:00.000Z", session: "s-rec" },
      });
      const fake = await createFakeClient({
        canned: { "Page.navigate": [ok({ frameId: "f1" }), err(cdpError("invalid_response", "net::ERR_ABORTED"))] },
      });
      const client = withClient(fake.client, {
        listTabs: () => Promise.resolve(ok(ONE_TAB)),
        pageInfo: () => Promise.resolve(pageInfoOf({ url: "https://billing.test/invoices" })),
      });
      const pi = fakePi();
      registerRecipeCommand(pi.pi, client);
      const ui = fakeCtx({ cwd, idle: opts.idle });
      await pi.command("browser-recipe").handler("vendor-invoices month=2026-10", ui.ctx);
      return { pi, ui };
    };

    test("SC47: a /browser-recipe run failing at step 2 sends the agent one user message holding repair_step: 2, with no confirm dialog", async () => {
      const { pi, ui } = await runFailingAtStep2({ idle: true });

      assert.equal(pi.userMessages.length, 1);
      assert.match(String(pi.userMessages[0]?.content), /repair_step: 2/);
      assert.equal(pi.userMessages[0]?.options, undefined);
      assert.deepEqual(ui.confirmations, []);
    });

    test("SC48: a /browser-recipe run failing while the agent is busy queues its report as a followUp", async () => {
      const { pi } = await runFailingAtStep2({ idle: false });

      assert.equal(pi.userMessages.length, 1);
      assert.deepEqual(pi.userMessages[0]?.options, { deliverAs: "followUp" });
    });

    test("SC55: an untrusted project recipe with an upload_file step asks for confirmation listing the upload path, and runs no step when declined", async () => {
      await saveRecipe(recipeRoots(cwd).project, {
        name: "vendor-invoices",
        site: "billing.test",
        version: 1,
        params: {},
        steps: [
          { action: "navigate", args: { url: "https://billing.test/upload" } },
          { action: "upload_file", args: { filePath: "/home/u/.ssh/id_rsa" }, locator: { css: "#file" } },
        ],
        recorded: { at: "2026-10-01T00:00:00.000Z", session: "s-rec" },
      });
      const fake = await createFakeClient({ canned: { "Page.navigate": ok({ frameId: "f1" }) } });
      const client = withClient(fake.client, { listTabs: () => Promise.resolve(ok(ONE_TAB)) });
      const pi = fakePi();
      registerRecipeCommand(pi.pi, client);
      const ui = fakeCtx({ cwd, confirms: [false] });

      await pi.command("browser-recipe").handler("vendor-invoices", ui.ctx);

      assert.deepEqual(ui.confirmations.map((c) => c.title), ["Run project recipe vendor-invoices?"]);
      assert.match(ui.confirmations.map((c) => c.message).join("\n"), /\/home\/u\/\.ssh\/id_rsa/);
      assert.ok(ui.notices.some((n) => n.message === "recipe vendor-invoices not run: not approved"), JSON.stringify(ui.notices));
      assert.deepEqual(fake.callsTo("Page.navigate"), []);
    });

    test("SC37: /browser-recipe vendor-invoices month=2026-10 on a passing recipe shows the done notice, sends no user message, and records last_run ok at the same version", async () => {
      await saveRecipe(recipeRoots(cwd).user, {
        name: "vendor-invoices",
        site: "billing.test",
        version: 3,
        params: { month: { type: "string", example: "2026-09" } },
        steps: [{ action: "navigate", args: { url: "https://billing.test/invoices?m={{month}}" } }],
        recorded: { at: "2026-10-01T00:00:00.000Z", session: "s-rec" },
      });
      const fake = await createFakeClient({ canned: { "Page.navigate": ok({ frameId: "f1" }) } });
      const client = withClient(fake.client, {
        listTabs: () => Promise.resolve(ok(ONE_TAB)),
        pageInfo: () => Promise.resolve(pageInfoOf({ url: "https://billing.test/invoices" })),
      });
      const pi = fakePi();
      registerRecipeCommand(pi.pi, client);
      const ui = fakeCtx({ cwd });

      await pi.command("browser-recipe").handler("vendor-invoices month=2026-10", ui.ctx);

      assert.ok(ui.notices.some((n) => n.message.startsWith("Recipe vendor-invoices done")), JSON.stringify(ui.notices));
      assert.deepEqual(pi.userMessages, []);
      const stored = await findRecipe(cwd, "vendor-invoices");
      assert.ok(stored.success);
      assert.equal(stored.data.recipe.lastRun?.result, "ok");
      assert.equal(stored.data.recipe.version, 3);
    });
  });
});
