import { Type } from "typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr } from "../util/tool";
import { applyParams, compileSteps, latestTask, siteOf } from "./compile";
import { type JournalEntry, activeJournal } from "./journal";
import { RECIPE_NAME, type Recipe, type RecipeStep, stringifyRecipe } from "./recipe";
import { type StoredRecipe, findRecipe, recipeRoots, saveRecipe } from "./store";
import { trustWritten } from "./trust";

const SaveArgs = Type.Object({
  name: Type.String({ pattern: RECIPE_NAME.source, description: "Recipe name, lowercase words joined by '-' (e.g. 'vendor-invoices-export')" }),
  params: Type.Optional(
    Type.Record(Type.String({ pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$" }), Type.String(), {
      description: "Values from this run that change between runs, by param name: { month: '2026-09' }. Each value becomes {{name}} in the steps.",
    }),
  ),
  project: Type.Optional(Type.Boolean({ description: "Save under the project's .pi/browser-recipes instead of the user's recipe folder" })),
  repair_step: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Repair an existing recipe after a failed replay: replace this step through the end with what you did since the failure. Use the step number the failure reported.",
    }),
  ),
});

// The user sees exactly what will be written; without a UI the agent's call is the confirmation.
export const confirmAndSave = async (
  ctx: ExtensionContext,
  root: string,
  recipe: Recipe,
  title: string,
): Promise<Result<StoredRecipe, ToolErr>> => {
  if (ctx.hasUI) {
    const yes = await ctx.ui.confirm(title, stringifyRecipe(recipe));
    if (!yes) return err({ kind: "invalid_state", message: "The user declined to save the recipe; nothing was written." });
  }
  const saved = await saveRecipe(root, recipe);
  if (!saved.success) return err({ kind: "io_error", message: saved.error });
  await trustWritten(saved.data, ctx.cwd);
  return ok(saved.data);
};

const fragileNote = (recipe: Recipe): string => {
  const steps = recipe.steps.flatMap((s, i) => (s.fragile === true ? [i + 1] : []));
  return steps.length === 0 ? "" : `\nFragile steps (located by coordinates, may break on layout changes): ${steps.join(", ")}`;
};

const isFailureMarker = (e: JournalEntry, name: string): boolean =>
  e.tool === "browser_run_recipe" && !e.ok && e.recipe?.name === name;

const stringParams = (args: JournalEntry["args"]): Record<string, string> =>
  Object.fromEntries(Object.entries(args).flatMap(([k, v]) => (typeof v === "string" ? [[k, v]] : [])));

// Steps 1..N-1 stay; N..end become what the agent did after the failed replay, templated with that run's params.
// A param the agent did not retype is not an error: the earlier steps still use it.
export const repairSteps = (
  recipe: Recipe,
  entries: ReadonlyArray<JournalEntry>,
  step: number,
): Result<{ readonly steps: ReadonlyArray<RecipeStep> }, string> => {
  let at = -1;
  for (let i = entries.length - 1; i >= 0 && at < 0; i--) {
    const e = entries[i];
    if (e !== undefined && isFailureMarker(e, recipe.name)) at = i;
  }
  const marker = entries[at];
  if (marker === undefined) return err(`no failed replay of ${recipe.name} in this session's journal`);
  if (marker.recipe?.step !== step) return err(`the last failed replay of ${recipe.name} stopped at step ${marker.recipe?.step ?? "?"}, not ${step}`);
  const after = entries.slice(at + 1).filter((e) => e.source === "agent");
  const compiled = compileSteps(after);
  if (!compiled.success) return err(`cannot repair from what was done after the failure: ${compiled.error}`);
  const declared = Object.fromEntries(Object.entries(stringParams(marker.args)).filter(([k]) => k in recipe.params));
  const templated = applyParams(compiled.data, declared);
  const steps = templated.success ? templated.data : compiled.data;
  return ok({ steps: [...recipe.steps.slice(0, step - 1), ...steps] });
};

export const saveRecipeTool = defineBrowserTool({
  name: "browser_save_recipe",
  label: "Save Browser Recipe",
  description:
    "Save the browser task you just finished as a named, replayable recipe. Compiles the page-changing calls of your most recent browser task from the session journal, turns the given param values into {{params}}, shows the recipe to the user to confirm, and writes a YAML file. Saving over an existing name keeps the previous version.",
  promptSnippet: "Save the last browser task as a replayable recipe",
  promptGuidelines: [
    "After finishing a multi-step browser task the user is likely to repeat (an export, a report, a routine check), offer once to save it as a recipe: propose a name and which typed or selected values are params. Do not offer again for the same task.",
    "Params are values that change between runs and that you typed, selected or put in a URL — a month, a search term, an id. Never make a button label or page text a param.",
  ],
  parameters: SaveArgs,
  concurrency: "parallel",
  ensureAlive: false,
  async handler(args, { extensionCtx }) {
    const journal = activeJournal();
    if (journal === undefined) return err({ kind: "invalid_state", message: "No browser journal is active in this session." });
    if (args.repair_step !== undefined) {
      const stored = await findRecipe(extensionCtx.cwd, args.name);
      if (!stored.success) return err({ kind: "invalid_args", message: stored.error });
      const repaired = repairSteps(stored.data.recipe, await journal.entries(), args.repair_step);
      if (!repaired.success) return err({ kind: "invalid_state", message: repaired.error });
      const recipe: Recipe = {
        ...stored.data.recipe,
        steps: repaired.data.steps,
        lastRun: { at: new Date().toISOString(), result: "ok", repairedStep: args.repair_step },
      };
      const saved = await confirmAndSave(extensionCtx, stored.data.root, recipe, `Repair recipe "${args.name}" from step ${args.repair_step}?`);
      if (!saved.success) return saved;
      const r = saved.data.recipe;
      return ok({
        text: `Repaired recipe ${r.name}: steps ${args.repair_step}–${r.steps.length} replaced, now v${r.version}; previous version kept in .history/.${fragileNote(r)}`,
        details: { name: r.name, version: r.version, path: saved.data.path, steps: r.steps.length },
      });
    }
    const task = latestTask(await journal.entries());
    const compiled = compileSteps(task);
    if (!compiled.success) return err({ kind: "invalid_state", message: compiled.error });
    const params = args.params ?? {};
    const steps = applyParams(compiled.data, params);
    if (!steps.success) return err({ kind: "invalid_args", message: steps.error });
    const recipe: Recipe = {
      name: args.name,
      site: siteOf(task),
      version: 1,
      params: Object.fromEntries(Object.entries(params).map(([k, v]) => [k, { type: "string", example: v }])),
      steps: steps.data,
      recorded: { at: new Date().toISOString(), session: extensionCtx.sessionManager.getSessionId() },
    };
    const roots = recipeRoots(extensionCtx.cwd);
    const saved = await confirmAndSave(extensionCtx, args.project === true ? roots.project : roots.user, recipe, `Save recipe "${args.name}"?`);
    if (!saved.success) return saved;
    const r = saved.data.recipe;
    return ok({
      text: `Saved recipe ${r.name} v${r.version} (${r.steps.length} steps) to ${saved.data.path}${fragileNote(r)}`,
      details: { name: r.name, version: r.version, path: saved.data.path, steps: r.steps.length },
    });
  },
});
