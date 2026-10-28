import type { TSchema } from "typebox";
import { Compile } from "typebox/compile";
import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "../client";
import { clickTool } from "../domains/click";
import { evalJs } from "../domains/cdp-call";
import { handleDialogTool } from "../domains/dialog";
import { dragAndDropTool } from "../domains/drag";
import { downloadTool, uploadFileTool } from "../domains/files";
import { fillTool, focusTool, selectOptionTool, setCheckedTool } from "../domains/form";
import { goBackTool, goForwardTool, reloadTool } from "../domains/history";
import { dispatchKeyTool, pressKeyTool, typeTool } from "../domains/keyboard";
import { navigateTool } from "../domains/navigate";
import { waitForLoadTool, waitForTool } from "../domains/page";
import { pageFunctionSource } from "../domains/page/inject";
import { hasVisiblePasswordField } from "../domains/page/recipe.page";
import { refreshRefs } from "../domains/ref-resolve";
import { scrollTool } from "../domains/scroll";
import { snapshotTool } from "../domains/snapshot";
import { newTabTool } from "../domains/tabs";
import { type Result, err } from "../util/result";
import { sleep } from "../util/sleep";
import type { DefinedBrowserTool, JsonObject, ToolErr, ToolOk } from "../util/tool";
import { findTarget } from "./find";
import { activeJournal } from "./journal";
import type { Recipe, RecipeStep, StepExpect } from "./recipe";
import { type LiveMessage, MESSAGE_ROLES, readLiveMessages } from "./recordable";

export type ReplayFailure = {
  readonly step: number;
  readonly action: string;
  readonly reason: string;
  readonly expected: string;
  readonly snapshot: string;
  readonly authWall: boolean;
};
export type ReplayOutcome = { readonly ok: true; readonly steps: number } | { readonly ok: false; readonly failure: ReplayFailure };

type ReplayCtx = { readonly client: BrowserClient; readonly signal: AbortSignal | undefined; readonly extensionCtx: ExtensionContext };
type Replayer = (args: Readonly<Record<string, unknown>>, ctx: ReplayCtx) => Promise<Result<ToolOk<unknown>, ToolErr>>;

// Validating against the tool's own schema narrows the built args to what its handler takes, so no cast is needed.
const replayer = <S extends TSchema, D extends TSchema>(tool: DefinedBrowserTool<S, D>): Replayer => {
  const validator = Compile(tool.parameters);
  return async (args, ctx) => {
    if (!validator.Check(args)) {
      return err({ kind: "invalid_args", message: `${tool.name}: ${validator.Errors(args).map((e) => e.message).join("; ")}` });
    }
    return tool.handler(args, { client: ctx.client, signal: ctx.signal, extensionCtx: ctx.extensionCtx, onUpdate: () => undefined });
  };
};

const REPLAYERS: ReadonlyMap<string, Replayer> = new Map([
  ["click", replayer(clickTool)],
  ["fill", replayer(fillTool)],
  ["select_option", replayer(selectOptionTool)],
  ["set_checked", replayer(setCheckedTool)],
  ["focus", replayer(focusTool)],
  ["dispatch_key", replayer(dispatchKeyTool)],
  ["upload_file", replayer(uploadFileTool)],
  ["type", replayer(typeTool)],
  ["press_key", replayer(pressKeyTool)],
  ["navigate", replayer(navigateTool)],
  ["go_back", replayer(goBackTool)],
  ["go_forward", replayer(goForwardTool)],
  ["reload", replayer(reloadTool)],
  ["scroll", replayer(scrollTool)],
  ["drag_and_drop", replayer(dragAndDropTool)],
  ["handle_dialog", replayer(handleDialogTool)],
  ["wait_for", replayer(waitForTool)],
  ["wait_for_load", replayer(waitForLoadTool)],
  ["new_tab", replayer(newTabTool)],
  ["download", replayer(downloadTool)],
]);

const EXPECT_TIMEOUT_MS = 5_000;
const POLL_MS = 250;

const fill = (s: string, params: Readonly<Record<string, string>>): string =>
  s.replace(/\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g, (whole, name: string) => params[name] ?? whole);

const fillArgs = (args: JsonObject, params: Readonly<Record<string, string>>): JsonObject => {
  const out: Record<string, JsonObject[string]> = {};
  for (const [k, v] of Object.entries(args)) out[k] = typeof v === "string" ? fill(v, params) : v;
  return out;
};

export const missingParams = (recipe: Recipe, params: Readonly<Record<string, string>>): ReadonlyArray<string> =>
  Object.keys(recipe.params).filter((p) => params[p] === undefined);

export const describeStep = (step: RecipeStep): string => {
  const l = step.locator;
  const target = l === undefined ? "" : "role" in l ? ` ${l.role} "${l.name}"` : "css" in l ? ` ${l.css}` : ` at (${l.x}, ${l.y})`;
  return `${step.action}${target}`;
};

const describeExpect = (e: StepExpect | undefined): string => {
  if (e === undefined) return "the action to succeed";
  const parts = [
    ...(e.url !== undefined ? [`page at ${e.url}`] : []),
    ...(e.appeared !== undefined ? [`one of ${e.appeared.map((a) => `${a.role} "${a.name}"`).join(", ")} to appear`] : []),
    ...(e.dialog !== undefined ? [`a ${e.dialog} dialog`] : []),
    ...(e.download === true ? ["a download to start"] : []),
  ];
  return parts.length > 0 ? parts.join("; ") : "the action to succeed";
};

const samePage = (a: string, b: string): boolean => {
  try {
    const x = new URL(a);
    const y = new URL(b);
    return x.origin === y.origin && x.pathname === y.pathname;
  } catch {
    return a === b;
  }
};

// A message's text often carries a count or a date that differs per run ("Exported 42 rows"), so only its leading
// words, up to the first one holding a digit and at most two, have to match.
const messagePrefix = (name: string): string => {
  const words = name.trim().toLowerCase().split(/\s+/);
  const cut = words.findIndex((w) => /\d/.test(w));
  return words.slice(0, cut === -1 ? words.length : cut).slice(0, 2).join(" ");
};

const messageShown = (live: ReadonlyArray<LiveMessage>, want: LiveMessage): boolean =>
  live.some((m) => m.role === want.role && m.name.toLowerCase().startsWith(messagePrefix(want.name)));

const anyAppeared = async (client: BrowserClient, appeared: ReadonlyArray<LiveMessage>): Promise<boolean> => {
  const messages = appeared.filter((a) => MESSAGE_ROLES.has(a.role));
  const elements = appeared.filter((a) => !MESSAGE_ROLES.has(a.role));
  if (messages.length > 0) {
    const live = await readLiveMessages(client);
    if (live !== undefined && messages.some((m) => messageShown(live, m))) return true;
  }
  if (elements.length === 0) return false;
  const refreshed = await refreshRefs(client);
  if (!refreshed.success) return false;
  return [...refreshed.data.cur.values()].some((s) => elements.some((a) => a.role === s.role && a.name === s.name));
};

const expectHolds = async (client: BrowserClient, e: StepExpect, downloadsBefore: number): Promise<boolean> => {
  const info = await client.pageInfo();
  if (!info.success) return false;
  if (e.dialog !== undefined && info.data.kind !== "dialog") return false;
  if (e.url !== undefined && (info.data.kind !== "page" || !samePage(info.data.url, e.url))) return false;
  if (e.download === true && client.session().downloadCount() <= downloadsBefore) return false;
  return e.appeared === undefined || (await anyAppeared(client, e.appeared));
};

const waitForExpect = async (client: BrowserClient, e: StepExpect, downloadsBefore: number, signal?: AbortSignal): Promise<boolean> => {
  const deadline = Date.now() + EXPECT_TIMEOUT_MS;
  for (;;) {
    if (await expectHolds(client, e, downloadsBefore)) return true;
    if (Date.now() >= deadline || signal?.aborted) return false;
    await sleep(POLL_MS, signal);
  }
};

const freshSnapshot = async (ctx: ReplayCtx): Promise<string> => {
  const r = await snapshotTool.handler({}, { ...ctx, onUpdate: () => undefined });
  return r.success ? r.data.text : `(snapshot unavailable: ${r.error.message})`;
};

const currentUrl = async (client: BrowserClient): Promise<string> => {
  const info = await client.pageInfo();
  return info.success && info.data.kind === "page" ? info.data.url : "";
};

const HAS_PASSWORD_EXPR = "(" + pageFunctionSource(hasVisiblePasswordField) + ")()";

const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname;
  } catch {
    return undefined;
  }
};

// The hosts a recipe is allowed to be on: its site, and every host a step navigates to or expects to land on.
const knownHosts = (recipe: Recipe, params: Readonly<Record<string, string>>): ReadonlySet<string> => {
  const hosts = new Set([recipe.site]);
  for (const s of recipe.steps) {
    const url = typeof s.args["url"] === "string" ? s.args["url"] : s.expect?.url;
    const host = url !== undefined ? hostOf(fill(url, params)) : undefined;
    if (host !== undefined) hosts.add(host);
  }
  return hosts;
};

const authWall = async (client: BrowserClient, hosts: ReadonlySet<string>): Promise<string | undefined> => {
  const url = await currentUrl(client);
  const host = hostOf(url);
  if (host !== undefined && host !== "" && !hosts.has(host)) return `the page left the recipe's site for ${host}`;
  const pw = await evalJs(client, HAS_PASSWORD_EXPR);
  if (pw.success && pw.data === true) return "the page is asking to sign in (a password field is showing)";
  return undefined;
};

// Runs every step through the tool that recorded it, with no model in the loop. The first step that fails, or whose
// page does not change the way the recorded run's did, stops the replay.
export const runRecipe = async (opts: {
  readonly client: BrowserClient;
  readonly extensionCtx: ExtensionContext;
  readonly recipe: Recipe;
  readonly params: Readonly<Record<string, string>>;
  readonly signal?: AbortSignal;
}): Promise<ReplayOutcome> => {
  const { client, recipe, params } = opts;
  const ctx: ReplayCtx = { client, signal: opts.signal, extensionCtx: opts.extensionCtx };
  const journal = activeJournal();
  const hosts = knownHosts(recipe, params);
  // A navigate returns before the next page renders, so a sign-in form can appear only after the check before a
  // step; looking again here keeps it from being reported as an ordinary missing element.
  const fail = async (step: number, s: RecipeStep, failure: string, wallFound = false): Promise<ReplayOutcome> => {
    const wall = wallFound ? undefined : await authWall(client, hosts);
    const reason = wall !== undefined ? `auth wall: ${wall}` : failure;
    const isWall = wallFound || wall !== undefined;
    await journal
      ?.append({ source: "replay", tool: "browser_run_recipe", replayable: false, args: { ...params }, password: false, url: await currentUrl(client), ok: false, error: reason, recipe: { name: recipe.name, step } })
      .catch(() => undefined);
    return { ok: false, failure: { step, action: describeStep(s), reason, expected: describeExpect(s.expect), snapshot: await freshSnapshot(ctx), authWall: isWall } };
  };

  for (const [i, step] of recipe.steps.entries()) {
    const n = i + 1;
    const wall = await authWall(client, hosts);
    if (wall !== undefined) return fail(n, step, `auth wall: ${wall}`, true);
    const run = REPLAYERS.get(step.action);
    if (run === undefined) return fail(n, step, `"${step.action}" is not a replayable action`);
    const args = fillArgs(step.args, params);
    const url = await currentUrl(client);
    const downloadsBefore = client.session().downloadCount();
    // The mutex is not reentrant: this only works because browser_run_recipe runs in the parallel lane.
    const release = await client.mutationMutex().acquire();
    let result: Result<ToolOk<unknown>, ToolErr>;
    try {
      if (step.locator !== undefined) {
        const locator = "role" in step.locator ? { ...step.locator, name: fill(step.locator.name, params) } : step.locator;
        const target = await findTarget(client, locator, opts.signal);
        if (!target.success) return await fail(n, step, target.error);
        result = await run({ ...args, ...target.data }, ctx);
      } else {
        result = await run(args, ctx);
      }
    } finally {
      release();
    }
    if (!result.success) return fail(n, step, result.error.message);
    if (step.expect !== undefined && !(await waitForExpect(client, step.expect, downloadsBefore, opts.signal))) {
      return fail(n, step, "the page did not change the way the recorded run did");
    }
    await journal
      ?.append({
        source: "replay",
        tool: `browser_${step.action}`,
        replayable: true,
        args,
        password: false,
        url,
        ok: true,
        recipe: { name: recipe.name, step: n },
        ...(step.locator !== undefined ? { locator: step.locator } : {}),
      })
      .catch(() => undefined);
  }
  return { ok: true, steps: recipe.steps.length };
};
