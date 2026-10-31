import { type Result, err, ok } from "../util/result";
import type { JsonObject } from "../util/tool";
import type { JournalEntry, Locator } from "./journal";
import { PARAM_FORMS, RECIPE_SITE, type RecipeStep, type StepExpect } from "./recipe";
import { MESSAGE_ROLES } from "./recordable";

const MAX_EXPECT_APPEARED = 3;

const shortName = (tool: string): string => (tool.startsWith("browser_") ? tool.slice("browser_".length) : tool);

// The agent's most recent browser task: every agent entry from the highest run that has one.
export const latestTask = (entries: ReadonlyArray<JournalEntry>): ReadonlyArray<JournalEntry> => {
  const agent = entries.filter((e) => e.source === "agent");
  const last = agent.reduce((max, e) => Math.max(max, e.run), 0);
  return agent.filter((e) => e.run === last);
};

// Calls whose effect is the page they land on; the elements of that page say nothing about the step.
const LOADS_PAGE: ReadonlySet<string> = new Set(["browser_navigate", "browser_new_tab", "browser_go_back", "browser_go_forward", "browser_reload"]);

// What a replay should see after the step. A new URL, a dialog, a download and a status or alert message are each
// a direct sign the step worked; elements that appeared are used only when there is none of these, since they are
// often whatever else the page happened to render.
const expectOf = (e: JournalEntry): StepExpect | undefined => {
  const c = e.change;
  if (c === undefined) return undefined;
  const url = c.url !== undefined && c.url !== e.url ? c.url : undefined;
  const messages = c.appeared.filter((a) => MESSAGE_ROLES.has(a.role));
  const strong = url !== undefined || c.dialog !== undefined || c.download === true || LOADS_PAGE.has(e.tool);
  const appeared = (messages.length > 0 ? messages : strong ? [] : c.appeared).slice(0, MAX_EXPECT_APPEARED);
  const expect: StepExpect = {
    ...(url !== undefined ? { url } : {}),
    ...(appeared.length > 0 ? { appeared } : {}),
    ...(c.dialog !== undefined ? { dialog: c.dialog } : {}),
    ...(c.download === true ? { download: true } : {}),
  };
  return Object.keys(expect).length > 0 ? expect : undefined;
};

const isPoint = (l: Locator | undefined): boolean => l !== undefined && "x" in l;

// Browser settings, not page actions: a replayed download folder would move the user's Chrome downloads for good.
const SETTINGS: ReadonlySet<string> = new Set(["browser_download"]);

// A script the journal measured to change nothing (see JournalEntry.readOnly): the agent only read the page with it,
// so replay does not need it and it is left out rather than refusing the save.
export const isNoEffectScript = (e: JournalEntry): boolean => e.ok && e.tool === "browser_execute_js" && e.readOnly === true;

export const compileSteps = (entries: ReadonlyArray<JournalEntry>): Result<ReadonlyArray<RecipeStep>, string> => {
  const steps: RecipeStep[] = [];
  let openedTab = false;
  for (const e of entries) {
    if (!e.ok || SETTINGS.has(e.tool) || isNoEffectScript(e)) continue;
    if (e.password) return err(`${e.tool} typed into a password field; recipes never type credentials, so this task cannot be saved`);
    if (!e.replayable) return err(`${e.tool} cannot be replayed; redo the task without it, or leave it out of the recipe`);
    if (e.tool === "browser_new_tab") openedTab = true;
    if (e.tool === "browser_close_tab" && !openedTab) {
      return err("browser_close_tab closes a tab the task did not open, so a replay would close the user's tab; leave the tab open, or start the task with browser_new_tab");
    }
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
      ...(e.wrote === true ? { writes: true } : {}),
    });
  }
  if (steps.length === 0) return err("the agent's last browser task made no page-changing calls to save");
  return ok(steps);
};

// The value as typed becomes {{name}}; its URL forms ("Alan_Turing", "Alan+Turing", "Alan%20Turing") become
// {{name|form}}, so a replay writes the new value the same way.
const template = (s: string, pairs: ReadonlyArray<readonly [string, string]>): string =>
  pairs.reduce((acc, [name, value]) => {
    let out = acc.split(value).join(`{{${name}}}`);
    for (const [form, apply] of PARAM_FORMS) {
      const shaped = apply(value);
      if (shaped !== value) out = out.split(shaped).join(`{{${name}|${form}}}`);
    }
    return out;
  }, s);

const templateArgs = (args: JsonObject, pairs: ReadonlyArray<readonly [string, string]>): JsonObject => {
  const out: Record<string, JsonObject[string]> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === "string" ? template(v, pairs) : v;
  return out;
};

const templateLocator = (l: Locator, pairs: ReadonlyArray<readonly [string, string]>): Locator =>
  "role" in l ? { ...l, name: template(l.name, pairs) } : l;

// The page a step lands on carries the param too: a repo's URL, an account's name in a heading.
const templateExpect = (e: StepExpect, pairs: ReadonlyArray<readonly [string, string]>): StepExpect => ({
  ...e,
  ...(e.url !== undefined ? { url: template(e.url, pairs) } : {}),
  ...(e.appeared !== undefined ? { appeared: e.appeared.map((a) => ({ ...a, name: template(a.name, pairs) })) } : {}),
});

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
    ...(s.expect !== undefined ? { expect: templateExpect(s.expect, pairs) } : {}),
  }));
  for (const [name, value] of pairs) {
    const placeholder = new RegExp(`\\{\\{${name}(\\|[a-z]+)?\\}\\}`);
    const used = out.some((s) => placeholder.test(JSON.stringify(s)));
    if (!used) return err(`param ${name}: the value "${value}" does not appear in the task's steps`);
  }
  return ok(out);
};

const OPENS_URL: ReadonlySet<string> = new Set(["browser_navigate", "browser_new_tab"]);

// A call that opens a page is on the page it opened; its e.url is the tab it started from, which may be another site.
const pageOf = (e: JournalEntry): string => {
  if (!OPENS_URL.has(e.tool)) return e.url;
  const url = e.args["url"];
  return typeof url === "string" ? url : (e.change?.url ?? "");
};

export const siteOf = (entries: ReadonlyArray<JournalEntry>): string => {
  for (const e of entries) {
    const url = pageOf(e);
    try {
      const host = new URL(url).hostname;
      if (RECIPE_SITE.test(host)) return host;
    } catch {
      // An unparseable URL names no site; try the next entry.
    }
  }
  return "unknown-site";
};
