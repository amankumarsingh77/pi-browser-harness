import { Type } from "typebox";
import { err, ok } from "../util/result";
import { defineBrowserTool } from "../util/tool";
import { RECIPE_NAME } from "./recipe";
import { type ReplayFailure, missingParams, runRecipe } from "./replay";
import { findRecipe, listRecipes, recordRun } from "./store";

const RunArgs = Type.Object({
  name: Type.Optional(Type.String({ pattern: RECIPE_NAME.source, description: "Recipe to run. Omit to list saved recipes." })),
  params: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Values for the recipe's params: { month: '2026-10' }" })),
});

export const listText = async (cwd: string): Promise<string> => {
  const all = await listRecipes(cwd);
  if (all.length === 0) return "No saved recipes.";
  return all
    .map(({ recipe: r, path }) => {
      const params = Object.entries(r.params).map(([k, v]) => `${k} (e.g. ${v.example})`).join(", ");
      return `- ${r.name} — ${r.site}, ${r.steps.length} steps, v${r.version}${params ? `, params: ${params}` : ""}\n  ${path}`;
    })
    .join("\n");
};

export const formatFailure = (name: string, f: ReplayFailure): string =>
  [`Recipe ${name} stopped at step ${f.step} (${f.action}): ${f.reason}`, `Expected: ${f.expected}`, "", "Page now:", f.snapshot].join("\n");

export const runRecipeTool = defineBrowserTool({
  name: "browser_run_recipe",
  label: "Run Browser Recipe",
  description:
    "Replay a saved browser recipe by name with its params, with no model calls between steps. Call with no name to list saved recipes and their params. A failed step stops the replay and returns the step, what was expected, and a fresh snapshot.",
  promptSnippet: "Replay a saved browser recipe, or list recipes",
  promptGuidelines: [
    "When the user asks to redo a browser task, call browser_run_recipe with no name first to see whether a saved recipe covers it.",
  ],
  parameters: RunArgs,
  // Must stay parallel: the replay takes the non-reentrant mutation mutex itself, per step.
  concurrency: "parallel",
  async handler(args, { client, signal, extensionCtx }) {
    const cwd = extensionCtx.cwd;
    if (args.name === undefined) return ok({ text: await listText(cwd) });
    const stored = await findRecipe(cwd, args.name);
    if (!stored.success) return err({ kind: "invalid_args", message: stored.error });
    const params = args.params ?? {};
    const missing = missingParams(stored.data.recipe, params);
    if (missing.length > 0) {
      const hints = missing.map((p) => `${p} (e.g. ${stored.data.recipe.params[p]?.example ?? ""})`).join(", ");
      return err({ kind: "invalid_args", message: `Recipe ${args.name} needs params: ${hints}` });
    }
    const outcome = await runRecipe({ client, extensionCtx, recipe: stored.data.recipe, params, ...(signal !== undefined ? { signal } : {}) });
    const at = new Date().toISOString();
    if (outcome.ok) {
      await recordRun(stored.data, { at, result: "ok" });
      return ok({ text: `Recipe ${args.name} ran ${outcome.steps} steps successfully.`, details: { name: args.name, steps: outcome.steps } });
    }
    await recordRun(stored.data, { at, result: "failed", step: outcome.failure.step });
    return err({ kind: "invalid_state", message: formatFailure(args.name, outcome.failure) });
  },
});
