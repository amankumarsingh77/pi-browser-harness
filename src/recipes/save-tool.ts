import { Type } from "typebox";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr } from "../util/tool";
import { applyParams, compileSteps, isNoEffectScript, latestTask, siteOf } from "./compile";
import { type JournalEntry, activeJournal } from "./journal";
import { RECIPE_NAME, type Recipe, type RecipeStep, stringifyRecipe } from "./recipe";
import { type StoredRecipe, findRecipe, recipeRoots, saveRecipe } from "./store";
import { printable, trustWritten } from "./trust";
import { describeStep, runRecipe } from "./replay";

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
      description: "Repair an existing recipe after a failed replay: replace this step through the end with what you did since the failure. Use the step number the failure reported. The repaired recipe is replayed before it is written, so finish the task from the page where it failed, without detours.",
    }),
  ),
});

// The user sees exactly what will be written, then any notes on it; without a UI the agent's call is the
// confirmation.
export const confirmAndSave = async (
  ctx: ExtensionContext,
  root: string,
  recipe: Recipe,
  title: string,
  notes = "",
): Promise<Result<StoredRecipe, ToolErr>> => {
  if (ctx.hasUI) {
    const yes = await ctx.ui.confirm(title, `${stringifyRecipe(recipe)}${notes === "" ? "" : `\n${notes}`}`);
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

const leftOutNote = (entries: ReadonlyArray<JournalEntry>): string => {
  const n = entries.filter(isNoEffectScript).length;
  return n === 0
    ? ""
    : `\nLeft out ${n} browser_execute_js call${n === 1 ? "" : "s"} that changed nothing on the page; if one of them did something the task needs, redo it with browser tools and save again.`;
};

const MAX_QUOTED = 120;

// Page text in the dialog is quoted on one line and cut short: a newline in it could forge lines of the dialog,
// and a long one could push the recipe out of view.
const quoted = (text: string): string => `"${printable(text.length > MAX_QUOTED ? `${text.slice(0, MAX_QUOTED)}…` : text)}"`;

const PLACEHOLDER = /\{\{[a-zA-Z_][a-zA-Z0-9_]*(?:\|[a-z]+)?\}\}/g;

// Text a step matches that the recorded run's page showed, which another run's page may not: a wait for page text
// with no param in it, and an element name holding a param next to other words. Saving cannot prove a recipe fits
// other values, so these are shown for the user and the agent to judge, not refused.
export const runSpecificText = (steps: ReadonlyArray<RecipeStep>): ReadonlyArray<string> =>
  steps.flatMap((s, i) => {
    const at = `step ${i + 1}`;
    const text = s.args["text"];
    const waits = s.action === "wait_for" && typeof text === "string" && text.match(PLACEHOLDER) === null ? [`${at}: waits for the text ${quoted(text)}`] : [];
    const names = [...(s.locator !== undefined && "name" in s.locator ? [s.locator.name] : []), ...(s.expect?.appeared ?? []).map((a) => a.name)];
    const mixed = names.filter((n) => n.match(PLACEHOLDER) !== null && n.replace(PLACEHOLDER, "").trim() !== "");
    return [...waits, ...mixed.map((n) => `${at}: ${printable(describeStep(s))} matches ${quoted(n)}`)];
  });

const specificNote = (steps: ReadonlyArray<RecipeStep>): string => {
  const found = runSpecificText(steps);
  return found.length === 0
    ? ""
    : `These steps match text from this run's page, which another run's page may not show; replace them with steps that do not depend on it if so:\n${found.join("\n")}\n`;
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
): Result<{ readonly steps: ReadonlyArray<RecipeStep>; readonly note: string; readonly params: Readonly<Record<string, string>> }, string> => {
  let at = -1;
  for (let i = entries.length - 1; i >= 0 && at < 0; i--) {
    const e = entries[i];
    if (e !== undefined && isFailureMarker(e, recipe.name)) at = i;
  }
  const marker = entries[at];
  if (marker === undefined) return err(`no failed replay of ${recipe.name} in this session's journal`);
  if (marker.recipe?.step !== step) return err(`the last failed replay of ${recipe.name} stopped at step ${marker.recipe?.step ?? "?"}, not ${step}`);
  const after = entries.slice(at + 1).filter((e) => e.source === "agent");
  const kept = recipe.steps.slice(0, step - 1);
  const compiled = compileSteps(after, kept.some((s) => s.action === "new_tab"));
  if (!compiled.success) return err(`cannot repair from what was done after the failure: ${compiled.error}`);
  const declared = Object.fromEntries(Object.entries(stringParams(marker.args)).filter(([k]) => k in recipe.params));
  const templated = applyParams(compiled.data, declared);
  const steps = templated.success ? templated.data : compiled.data;
  return ok({ steps: [...kept, ...steps], note: leftOutNote(after), params: stringParams(marker.args) });
};

// Actions that only load or read a page, or wait, and so cannot send data however they were recorded.
const READS_ONLY: ReadonlySet<string> = new Set(["navigate", "new_tab", "go_back", "go_forward", "wait_for", "wait_for_load", "scroll", "focus", "close_tab"]);

// What running a step again would repeat beyond the page itself. In a recipe saved before steps were marked, any
// other step may have sent data, so it is listed too: the gate fails closed.
const sideEffectsOf = (recipe: Recipe): ReadonlyArray<string> =>
  recipe.steps.flatMap((s, i) => {
    const unmarked = recipe.writesTracked !== true && !READS_ONLY.has(s.action) && s.writes !== true;
    const effects = [
      ...(s.action === "upload_file" ? ["uploads a file"] : []),
      ...(s.action === "download" ? ["changes where downloads go"] : []),
      ...(s.expect?.download === true ? ["starts a download"] : []),
      ...(s.writes === true ? ["sends data to the site"] : []),
      ...(unmarked ? ["may send data to the site: saved before this was tracked"] : []),
    ];
    return effects.length > 0 ? [`step ${i + 1}: ${describeStep(s)} (${effects.join(", ")})`] : [];
  });

// A repair is built from whatever the agent did after the failure, detours included, so it is replayed from step 1
// before it is written. A replay repeats side effects, so when the steps have any the user decides; with no UI to
// ask, the repair is written unchecked and says so.
const checkRepair = async (
  client: BrowserClient,
  ctx: ExtensionContext,
  recipe: Recipe,
  params: Readonly<Record<string, string>>,
  signal: AbortSignal | undefined,
): Promise<Result<string, string>> => {
  const effects = sideEffectsOf(recipe);
  if (effects.length > 0) {
    const why = `a check runs every step again, including:\n${effects.join("\n")}`;
    if (!ctx.hasUI) return ok(`Not checked by a replay: ${why}\nRun the recipe to check it.`);
    const go = await ctx.ui.confirm(`Check the repaired recipe "${recipe.name}" by running it?`, `${why}\n\nChoose No to save it without the check.`);
    if (!go) return ok("Not checked by a replay: the user chose not to run its steps again.");
  }
  const outcome = await runRecipe({ client, extensionCtx: ctx, recipe, params, record: false, ...(signal !== undefined ? { signal } : {}) });
  if (!outcome.ok) {
    const f = outcome.failure;
    return err(
      `repair not saved: a replay of the repaired recipe stopped at step ${f.step} (${f.action}): ${f.reason}. The steps after the failure did not redo the task from where it stopped. Run the recipe again with browser_run_recipe for a fresh failure, finish the task from that page with browser tools, then repair from the step it reports.`,
    );
  }
  return ok(`Checked: a replay of all ${outcome.steps} steps passed.`);
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
  async handler(args, { client, extensionCtx, signal }) {
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
      const checked = await checkRepair(client, extensionCtx, recipe, repaired.data.params, signal);
      if (!checked.success) return err({ kind: "invalid_state", message: checked.error });
      const notes = specificNote(recipe.steps);
      const saved = await confirmAndSave(extensionCtx, stored.data.root, recipe, `Repair recipe "${args.name}" from step ${args.repair_step}?`, notes);
      if (!saved.success) return saved;
      const r = saved.data.recipe;
      return ok({
        text: `Repaired recipe ${r.name}: steps ${args.repair_step}–${r.steps.length} replaced, now v${r.version}; previous version kept in .history/.\n${checked.data}${fragileNote(r)}${repaired.data.note}${notes === "" ? "" : `\n${notes.trimEnd()}`}`,
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
      writesTracked: true,
    };
    const roots = recipeRoots(extensionCtx.cwd);
    const notes = specificNote(recipe.steps);
    const saved = await confirmAndSave(extensionCtx, args.project === true ? roots.project : roots.user, recipe, `Save recipe "${args.name}"?`, notes);
    if (!saved.success) return saved;
    const r = saved.data.recipe;
    return ok({
      text: `Saved recipe ${r.name} v${r.version} (${r.steps.length} steps) to ${saved.data.path}${fragileNote(r)}${leftOutNote(task)}${notes === "" ? "" : `\n${notes.trimEnd()}`}`,
      details: { name: r.name, version: r.version, path: saved.data.path, steps: r.steps.length },
    });
  },
});
