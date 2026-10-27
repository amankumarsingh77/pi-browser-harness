import { Type } from "typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr } from "../util/tool";
import { applyParams, compileSteps, latestTask, siteOf } from "./compile";
import { activeJournal } from "./journal";
import { RECIPE_NAME, type Recipe, stringifyRecipe } from "./recipe";
import { type StoredRecipe, recipeRoots, saveRecipe } from "./store";

const SaveArgs = Type.Object({
  name: Type.String({ pattern: RECIPE_NAME.source, description: "Recipe name, lowercase words joined by '-' (e.g. 'vendor-invoices-export')" }),
  params: Type.Optional(
    Type.Record(Type.String({ pattern: "^[a-zA-Z_][a-zA-Z0-9_]*$" }), Type.String(), {
      description: "Values from this run that change between runs, by param name: { month: '2026-09' }. Each value becomes {{name}} in the steps.",
    }),
  ),
  project: Type.Optional(Type.Boolean({ description: "Save under the project's .pi/browser-recipes instead of the user's recipe folder" })),
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
  return ok(saved.data);
};

const fragileNote = (recipe: Recipe): string => {
  const steps = recipe.steps.flatMap((s, i) => (s.fragile === true ? [i + 1] : []));
  return steps.length === 0 ? "" : `\nFragile steps (located by coordinates, may break on layout changes): ${steps.join(", ")}`;
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
