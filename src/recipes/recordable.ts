import type { BrowserClient } from "../client";
import type { RefSignature } from "../cdp/types";
import { cdpCall, evalJs } from "../domains/cdp-call";
import { runOnElement } from "../domains/element-call";
import { elementFunctionSource, pageFunctionSource } from "../domains/page/inject";
import { focusedIsPassword, interactiveAt, isPasswordInput, liveMessages } from "../domains/page/recipe.page";
import { refreshRefs } from "../domains/ref-resolve";
import { safeJs } from "../util/js-template";
import type { CallObserver, JsonObject } from "../util/tool";
import { isRecord } from "../util/guards";
import { type Journal, type JournalFieldEntry, type Locator, type ObservedChange, activeJournal } from "./journal";

// How a replayable tool names its element: by `ref`/`selector`/x-y, by a `fields` list, or not at all.
export const REPLAYABLE: ReadonlyMap<string, "ref" | "fields" | "none"> = new Map([
  ["browser_click", "ref"],
  ["browser_fill", "ref"],
  ["browser_select_option", "ref"],
  ["browser_set_checked", "ref"],
  ["browser_focus", "ref"],
  ["browser_dispatch_key", "ref"],
  ["browser_upload_file", "ref"],
  ["browser_fill_form", "fields"],
  ["browser_type", "none"],
  ["browser_press_key", "none"],
  ["browser_navigate", "none"],
  ["browser_go_back", "none"],
  ["browser_go_forward", "none"],
  ["browser_reload", "none"],
  ["browser_scroll", "none"],
  ["browser_drag_and_drop", "none"],
  ["browser_handle_dialog", "none"],
  ["browser_wait_for", "none"],
  ["browser_wait_for_load", "none"],
  ["browser_new_tab", "none"],
  ["browser_download", "none"],
]);

// Page-changing calls a recipe cannot replay safely: arbitrary code, or a handle that only means something now.
export const NON_REPLAYABLE: ReadonlySet<string> = new Set([
  "browser_execute_js",
  "browser_run_script",
  "browser_switch_tab",
  "browser_close_tab",
  "browser_open_urls",
  "browser_set_headers",
  "browser_clear_headers",
  "browser_viewport_resize",
  "browser_print_to_pdf",
]);

const IGNORED: ReadonlySet<string> = new Set(["browser_setup", "browser_web_search", "browser_save_recipe", "browser_run_recipe"]);

// Args a ref-mode tool turns into its locator, so the step need not keep them.
const HANDLE_KEYS: ReadonlySet<string> = new Set(["ref", "selector", "x", "y"]);
const MAX_APPEARED = 5;

// Steps a task needs before it is worth saving. The hint rides on the result that reaches this count, so it is shown
// once per run however long the task goes on; a run with a failed replay is left alone, since its next step is repair.
const SAVE_HINT_STEPS = 3;
const SAVE_HINT =
  "This browser task is now several replayable steps long. When the whole task is done, end your final message with one offer to save it as a recipe with browser_save_recipe (a proposed name and params). Offer once; do not repeat it.";

const saveHint = async (journal: Journal): Promise<string | undefined> => {
  const entries = await journal.entries();
  const run = entries[entries.length - 1]?.run;
  const current = entries.filter((e) => e.run === run);
  if (current.some((e) => e.tool === "browser_run_recipe")) return undefined;
  const steps = current.filter((e) => e.source === "agent" && e.ok && e.replayable).length;
  return steps === SAVE_HINT_STEPS ? SAVE_HINT : undefined;
};

const FOCUSED_IS_PASSWORD_EXPR = "(" + pageFunctionSource(focusedIsPassword) + ")()";
const INTERACTIVE_AT_SRC = "(" + pageFunctionSource(interactiveAt) + ")";
const IS_PASSWORD_FN = elementFunctionSource(isPasswordInput);
const LIVE_MESSAGES_EXPR = "(" + pageFunctionSource(liveMessages) + ")()";

export type LiveMessage = { readonly role: string; readonly name: string };

// Roles liveMessages reports. They have no ref, so replay matches them against the page's messages instead.
export const MESSAGE_ROLES: ReadonlySet<string> = new Set(["status", "alert", "alertdialog"]);

// The page's visible status and alert messages, or undefined when the page could not be read.
export const readLiveMessages = async (client: BrowserClient): Promise<ReadonlyArray<LiveMessage> | undefined> => {
  const r = await evalJs(client, LIVE_MESSAGES_EXPR);
  if (!r.success || !Array.isArray(r.data)) return undefined;
  return r.data.flatMap((m) => (isRecord(m) && typeof m["role"] === "string" && typeof m["name"] === "string" ? [{ role: m["role"], name: m["name"] }] : []));
};

const sameKey = (a: RefSignature, b: RefSignature): boolean => a.role === b.role && a.name === b.name;

// Role+name plus the element's position among same-named elements, in the ref map's tree order.
export const locatorOfRef = (client: BrowserClient, ref: string): Locator | undefined => {
  const sigs = client.session().refSignatures();
  const sig = sigs.get(ref);
  if (sig === undefined) return undefined;
  let nth = 0;
  for (const [r, s] of sigs) {
    if (r === ref) break;
    if (sameKey(s, sig)) nth += 1;
  }
  return { role: sig.role, name: sig.name, nth };
};

const locatorAtPoint = async (client: BrowserClient, x: number, y: number): Promise<Locator> => {
  const point: Locator = { x, y };
  const hit = await cdpCall(client, "Runtime.evaluate", {
    expression: INTERACTIVE_AT_SRC + safeJs`(${x}, ${y})`,
    returnByValue: false,
  });
  const objectId = hit.success ? hit.data.result.objectId : undefined;
  if (objectId === undefined) return point;
  const described = await cdpCall(client, "DOM.describeNode", { objectId });
  if (!described.success) return point;
  const refreshed = await refreshRefs(client);
  if (!refreshed.success) return point;
  for (const [ref, backendId] of client.session().refMappings()) {
    if (backendId === described.data.node.backendNodeId) return locatorOfRef(client, ref) ?? point;
  }
  return point;
};

const isPasswordTarget = async (client: BrowserClient, ref: string | undefined, selector: string | undefined): Promise<boolean> => {
  const r = await runOnElement(client, { ref, selector, functionDeclaration: IS_PASSWORD_FN, args: [] });
  return r.success && r.data.found && r.data.value === true;
};

const urlOf = async (client: BrowserClient): Promise<string> => {
  const info = await client.pageInfo();
  return info.success && info.data.kind === "page" ? info.data.url : "";
};

export type BeforeCall = {
  // The page's elements read just before the call; undefined when that read failed, and then none are recorded.
  readonly refs: ReadonlyMap<string, RefSignature> | undefined;
  readonly downloads: number;
  // Undefined when the messages could not be read before the call; then none are recorded.
  readonly messages: ReadonlyArray<LiveMessage> | undefined;
};

const keyOf = (m: LiveMessage): string => `${m.role}\u0000${m.name}`;

const newMessages = async (client: BrowserClient, before: ReadonlyArray<LiveMessage> | undefined): Promise<ReadonlyArray<LiveMessage>> => {
  if (before === undefined) return [];
  const after = await readLiveMessages(client);
  if (after === undefined) return [];
  // Seeded with what was there before; each new message is added as it is taken, so nested live regions count once.
  const seen = new Set(before.map(keyOf));
  return after.filter((m) => !seen.has(keyOf(m)) && Boolean(seen.add(keyOf(m))));
};

// What the page did after the call: where it is now, which named elements and messages appeared, whether a dialog
// opened, and whether a download began.
export const observeChange = async (client: BrowserClient, before: BeforeCall): Promise<ObservedChange> => {
  const info = await client.pageInfo();
  const dialog = info.success && info.data.kind === "dialog" ? info.data.dialog.type : undefined;
  const url = info.success && info.data.kind === "page" ? info.data.url : undefined;
  const refreshed = await refreshRefs(client);
  const had = new Set([...(before.refs ?? new Map<string, RefSignature>()).values()].map(keyOf));
  const elements =
    refreshed.success && before.refs !== undefined
      ? [...refreshed.data.cur.values()].filter((sig) => sig.name !== "" && !had.has(keyOf(sig))).map((sig) => ({ role: sig.role, name: sig.name }))
      : [];
  // Messages go first: a toast is the clearest sign an action worked, and the cap must not crowd it out.
  const appeared = [...(await newMessages(client, before.messages)), ...elements].slice(0, MAX_APPEARED);
  const download = client.session().downloadCount() > before.downloads;
  return {
    appeared,
    ...(url !== undefined ? { url } : {}),
    ...(dialog !== undefined ? { dialog } : {}),
    ...(download ? { download: true } : {}),
  };
};

const stringArg = (args: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
};

const numberArg = (args: Readonly<Record<string, unknown>>, key: string): number | undefined => {
  const v = args[key];
  return typeof v === "number" ? v : undefined;
};

// A ref is a handle into this session only, so it is never kept; selector and x/y are the step itself for a tool
// with no locator, such as browser_wait_for or browser_scroll.
const plainArgs = (args: Readonly<Record<string, unknown>>, redact: boolean, located: boolean): JsonObject => {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(args)) {
    if (k === "ref" || k === "fields" || (located && HANDLE_KEYS.has(k))) continue;
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") out[k] = v;
  }
  if (redact) {
    if ("value" in out) out["value"] = "";
    if ("text" in out) out["text"] = "";
  }
  return out;
};

const fieldsOf = async (client: BrowserClient, args: Readonly<Record<string, unknown>>): Promise<ReadonlyArray<JournalFieldEntry>> => {
  const raw = args["fields"];
  if (!Array.isArray(raw)) return [];
  const out: JournalFieldEntry[] = [];
  for (const f of raw) {
    if (!isRecord(f)) continue;
    const ref = stringArg(f, "ref");
    const value = stringArg(f, "value") ?? "";
    const password = ref !== undefined && (await isPasswordTarget(client, ref, undefined));
    const locator = ref !== undefined ? locatorOfRef(client, ref) : undefined;
    out.push({ value: password ? "" : value, password, ...(locator !== undefined ? { locator } : {}) });
  }
  return out;
};

// Watches one tool call for the journal. Returns undefined when the call is not journaled, otherwise the function
// that records the outcome and returns the save hint when this call is due one. Any error inside is dropped:
// observing must never change whether the call it watches succeeds.
export const observeCall: CallObserver = async ({ name, concurrency, args, client }) => {
  const journal = activeJournal();
  if (journal === undefined || IGNORED.has(name) || !isRecord(args)) return undefined;
  const mode = REPLAYABLE.get(name);
  const known = mode !== undefined || NON_REPLAYABLE.has(name);
  if (!known && concurrency === "parallel") return undefined;
  try {
    // Read the page now, not from the agent's last snapshot: that one may be cut short or from another tab, and
    // everything missing from it would look like it appeared after this call. Refs the agent holds keep their names.
    const baseline = await refreshRefs(client);
    const ref = stringArg(args, "ref");
    const selector = stringArg(args, "selector");
    const x = numberArg(args, "x");
    const y = numberArg(args, "y");
    let locator: Locator | undefined;
    if (mode === "ref") {
      if (ref !== undefined) locator = locatorOfRef(client, ref);
      else if (selector !== undefined) locator = { css: selector };
      else if (x !== undefined && y !== undefined) locator = await locatorAtPoint(client, x, y);
    }
    const fields = mode === "fields" ? await fieldsOf(client, args) : undefined;
    let password = fields?.some((f) => f.password) ?? false;
    if (name === "browser_fill") password = await isPasswordTarget(client, ref, selector);
    if (name === "browser_type") {
      const r = await evalJs(client, FOCUSED_IS_PASSWORD_EXPR);
      password = r.success && r.data === true;
    }
    const url = await urlOf(client);
    const before: BeforeCall = {
      refs: baseline.success ? baseline.data.cur : undefined,
      downloads: client.session().downloadCount(),
      messages: await readLiveMessages(client),
    };
    return async (outcome) => {
      try {
        const change = outcome.ok ? await observeChange(client, before) : undefined;
        await journal.append({
          source: "agent",
          tool: name,
          replayable: mode !== undefined,
          args: plainArgs(args, password, mode === "ref"),
          password,
          url,
          ok: outcome.ok,
          ...(locator !== undefined ? { locator } : {}),
          ...(fields !== undefined ? { fields } : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          ...(change !== undefined ? { change } : {}),
        });
        return outcome.ok && mode !== undefined ? await saveHint(journal) : undefined;
      } catch {
        // Journal write failures are dropped; the tool already ran.
        return undefined;
      }
    };
  } catch {
    return undefined;
  }
};
