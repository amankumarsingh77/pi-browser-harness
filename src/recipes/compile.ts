import { type Result, err, ok } from "../util/result";
import type { JsonObject } from "../util/tool";
import type { JournalEntry, Locator } from "./journal";
import { RECIPE_SITE, type RecipeStep, type StepExpect } from "./recipe";

const MAX_EXPECT_APPEARED = 3;

const shortName = (tool: string): string => (tool.startsWith("browser_") ? tool.slice("browser_".length) : tool);

// The agent's most recent browser task: every agent entry from the highest run that has one.
export const latestTask = (entries: ReadonlyArray<JournalEntry>): ReadonlyArray<JournalEntry> => {
  const agent = entries.filter((e) => e.source === "agent");
  const last = agent.reduce((max, e) => Math.max(max, e.run), 0);
  return agent.filter((e) => e.run === last);
};

const expectOf = (e: JournalEntry): StepExpect | undefined => {
  const c = e.change;
  if (c === undefined) return undefined;
  const appeared = c.appeared.slice(0, MAX_EXPECT_APPEARED);
  const expect: StepExpect = {
    ...(c.url !== undefined && c.url !== e.url ? { url: c.url } : {}),
    ...(appeared.length > 0 ? { appeared } : {}),
    ...(c.dialog !== undefined ? { dialog: c.dialog } : {}),
    ...(c.download === true ? { download: true } : {}),
  };
  return Object.keys(expect).length > 0 ? expect : undefined;
};

const isPoint = (l: Locator | undefined): boolean => l !== undefined && "x" in l;

export const compileSteps = (entries: ReadonlyArray<JournalEntry>): Result<ReadonlyArray<RecipeStep>, string> => {
  const steps: RecipeStep[] = [];
  for (const e of entries) {
    if (!e.ok) continue;
    if (e.password) return err(`${e.tool} typed into a password field; recipes never type credentials, so this task cannot be saved`);
    if (!e.replayable) return err(`${e.tool} cannot be replayed; redo the task without it, or leave it out of the recipe`);
    const expect = expectOf(e);
    if (e.tool === "browser_fill_form") {
      for (const f of e.fields ?? []) {
        steps.push({ action: "fill", args: { value: f.value }, ...(f.locator !== undefined ? { locator: f.locator } : {}) });
      }
      continue;
    }
    const fragile = isPoint(e.locator) || e.tool === "browser_drag_and_drop";
    steps.push({
      action: shortName(e.tool),
      args: e.args,
      ...(e.locator !== undefined ? { locator: e.locator } : {}),
      ...(expect !== undefined ? { expect } : {}),
      ...(fragile ? { fragile: true } : {}),
    });
  }
  if (steps.length === 0) return err("the agent's last browser task made no page-changing calls to save");
  return ok(steps);
};

const template = (s: string, pairs: ReadonlyArray<readonly [string, string]>): string =>
  pairs.reduce((acc, [name, value]) => acc.split(value).join(`{{${name}}}`), s);

const templateArgs = (args: JsonObject, pairs: ReadonlyArray<readonly [string, string]>): JsonObject => {
  const out: Record<string, JsonObject[string]> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === "string" ? template(v, pairs) : v;
  return out;
};

const templateLocator = (l: Locator, pairs: ReadonlyArray<readonly [string, string]>): Locator =>
  "role" in l ? { ...l, name: template(l.name, pairs) } : l;

// Every occurrence of a param's value becomes {{name}}; longer values go first so "2026-09-01" is not split by "2026-09".
export const applyParams = (
  steps: ReadonlyArray<RecipeStep>,
  params: Readonly<Record<string, string>>,
): Result<ReadonlyArray<RecipeStep>, string> => {
  const pairs = [...Object.entries(params)].sort((a, b) => b[1].length - a[1].length);
  const empty = pairs.find(([, v]) => v === "");
  if (empty !== undefined) return err(`param ${empty[0]} has an empty value`);
  const out = steps.map((s) => ({
    ...s,
    args: templateArgs(s.args, pairs),
    ...(s.locator !== undefined ? { locator: templateLocator(s.locator, pairs) } : {}),
  }));
  for (const [name, value] of pairs) {
    const used = out.some((s) => JSON.stringify(s).includes(`{{${name}}}`));
    if (!used) return err(`param ${name}: the value "${value}" does not appear in the task's steps`);
  }
  return ok(out);
};

export const siteOf = (entries: ReadonlyArray<JournalEntry>): string => {
  for (const e of entries) {
    const url = e.tool === "browser_navigate" && typeof e.args["url"] === "string" ? e.args["url"] : e.url;
    try {
      const host = new URL(url).hostname;
      if (RECIPE_SITE.test(host)) return host;
    } catch {
      // An unparseable URL names no site; try the next entry.
    }
  }
  return "unknown-site";
};
