import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "../client";
import { missingParams, runRecipe } from "./replay";
import { formatFailureHandoff, listText } from "./run-tool";
import { findRecipe, listRecipes, recordRun } from "./store";
import { approveProjectRecipe, trustWritten } from "./trust";

const TOKEN = /([^\s=]+)="([^"]*)"|(\S+)/g;

// `NAME key=value key="two words"`: the first bare word is the name, a double-quoted value stays whole, and the
// bare words after an unquoted value join it, so `topic=Grace Hopper` is "Grace Hopper", not "Grace".
export const parseCommandArgs = (raw: string): { readonly name: string | undefined; readonly params: Readonly<Record<string, string>> } => {
  let name: string | undefined;
  let open: string | undefined;
  const params: Record<string, string> = {};
  for (const m of raw.matchAll(TOKEN)) {
    const [, quotedKey, quotedValue, bare] = m;
    if (quotedKey !== undefined && quotedValue !== undefined) {
      params[quotedKey] = quotedValue;
      open = undefined;
    } else if (bare?.includes("=") === true) {
      const at = bare.indexOf("=");
      open = bare.slice(0, at);
      params[open] = bare.slice(at + 1);
    } else if (bare !== undefined && name === undefined) {
      name = bare;
    } else if (bare !== undefined && open !== undefined) {
      params[open] = `${params[open] ?? ""} ${bare}`;
    }
  }
  return { name, params };
};

// Runs the replay engine directly, so a command run never starts a model turn.
export const registerRecipeCommand = (pi: Pick<ExtensionAPI, "registerCommand" | "sendUserMessage">, client: BrowserClient): void => {
  pi.registerCommand("browser-recipe", {
    description: "Replay a saved browser recipe with no model calls: /browser-recipe NAME key=value. No name lists recipes.",
    getArgumentCompletions: async (prefix) => {
      const all = await listRecipes(process.cwd());
      return all
        .map((s) => s.recipe.name)
        .filter((n) => n.startsWith(prefix))
        .map((n) => ({ value: n, label: n }));
    },
    handler: async (raw, ctx) => {
      const { name, params } = parseCommandArgs(raw);
      if (name === undefined) {
        ctx.ui.notify(await listText(ctx.cwd), "info");
        return;
      }
      const alive = await client.ensureAlive();
      if (!alive.success) {
        ctx.ui.notify(`Browser not connected: ${alive.error.message}. Run /browser-setup first.`, "error");
        return;
      }
      const stored = await findRecipe(ctx.cwd, name);
      if (!stored.success) {
        ctx.ui.notify(stored.error, "error");
        return;
      }
      const missing = missingParams(stored.data.recipe, params);
      if (missing.length > 0) {
        ctx.ui.notify(`Recipe ${name} needs: ${missing.map((p) => `${p}=… (e.g. ${stored.data.recipe.params[p]?.example ?? ""})`).join(" ")}`, "error");
        return;
      }
      const approved = await approveProjectRecipe(ctx, stored.data, params);
      if (!approved.success) {
        ctx.ui.notify(approved.error, "error");
        return;
      }
      ctx.ui.notify(`Running recipe ${name}…`, "info");
      const outcome = await runRecipe({ client, extensionCtx: ctx, recipe: stored.data.recipe, params });
      const at = new Date().toISOString();
      if (outcome.ok) {
        await recordRun(stored.data, { at, result: "ok" });
        await trustWritten(stored.data, ctx.cwd);
        ctx.ui.notify(`Recipe ${name} done: ${outcome.steps} steps ✓`, "info");
        return;
      }
      await recordRun(stored.data, { at, result: "failed", step: outcome.failure.step });
      await trustWritten(stored.data, ctx.cwd);
      ctx.ui.notify(`Recipe ${name} failed at step ${outcome.failure.step}; handing it to the agent to finish the task and repair the recipe.`, "warning");
      const report = `/browser-recipe ${name} failed. ${formatFailureHandoff(stored.data.recipe, params, outcome.failure)}`;
      if (ctx.isIdle()) pi.sendUserMessage(report);
      else pi.sendUserMessage(report, { deliverAs: "followUp" });
    },
  });
};
