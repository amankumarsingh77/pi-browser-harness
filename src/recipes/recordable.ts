import type { BrowserClient } from "../client";
import type { RefSignature } from "../cdp/types";
import { cdpCall, evalJs } from "../domains/cdp-call";
import { runOnElement } from "../domains/element-call";
import { elementFunctionSource, pageFunctionSource } from "../domains/page/inject";
import { focusedIsPassword, interactiveAt, isPasswordInput } from "../domains/page/recipe.page";
import { refreshRefs } from "../domains/ref-resolve";
import { safeJs } from "../util/js-template";
import type { CallObserver, JsonObject } from "../util/tool";
import { isRecord } from "../util/guards";
import { type JournalFieldEntry, type Locator, type ObservedChange, activeJournal } from "./journal";

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

const HANDLE_KEYS: ReadonlySet<string> = new Set(["ref", "selector", "x", "y"]);
const MAX_APPEARED = 5;

const FOCUSED_IS_PASSWORD_EXPR = "(" + pageFunctionSource(focusedIsPassword) + ")()";
const INTERACTIVE_AT_SRC = "(" + pageFunctionSource(interactiveAt) + ")";
const IS_PASSWORD_FN = elementFunctionSource(isPasswordInput);

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

// What the page did after the call: where it is now, which named elements appeared, and whether a dialog opened.
export const observeChange = async (client: BrowserClient, before: ReadonlyMap<string, RefSignature>): Promise<ObservedChange> => {
  const info = await client.pageInfo();
  const dialog = info.success && info.data.kind === "dialog" ? info.data.dialog.type : undefined;
  const url = info.success && info.data.kind === "page" ? info.data.url : undefined;
  const refreshed = await refreshRefs(client);
  const appeared: Array<{ role: string; name: string }> = [];
  if (refreshed.success) {
    const had = new Set([...before.values()].map((s) => `${s.role}\u0000${s.name}`));
    for (const sig of refreshed.data.cur.values()) {
      if (appeared.length >= MAX_APPEARED) break;
      if (sig.name === "" || had.has(`${sig.role}\u0000${sig.name}`)) continue;
      appeared.push({ role: sig.role, name: sig.name });
    }
  }
  return { appeared, ...(url !== undefined ? { url } : {}), ...(dialog !== undefined ? { dialog } : {}) };
};

const stringArg = (args: Readonly<Record<string, unknown>>, key: string): string | undefined => {
  const v = args[key];
  return typeof v === "string" ? v : undefined;
};

const numberArg = (args: Readonly<Record<string, unknown>>, key: string): number | undefined => {
  const v = args[key];
  return typeof v === "number" ? v : undefined;
};

const plainArgs = (args: Readonly<Record<string, unknown>>, redact: boolean): JsonObject => {
  const out: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(args)) {
    if (HANDLE_KEYS.has(k) || k === "fields") continue;
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
// that records the outcome. Any error inside is dropped: observing must never change the call it watches.
export const observeCall: CallObserver = async ({ name, concurrency, args, client }) => {
  const journal = activeJournal();
  if (journal === undefined || IGNORED.has(name) || !isRecord(args)) return undefined;
  const mode = REPLAYABLE.get(name);
  const known = mode !== undefined || NON_REPLAYABLE.has(name);
  if (!known && concurrency === "parallel") return undefined;
  try {
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
    const before = new Map(client.session().refSignatures());
    return async (outcome) => {
      try {
        const change = outcome.ok ? await observeChange(client, before) : undefined;
        await journal.append({
          source: "agent",
          tool: name,
          replayable: mode !== undefined,
          args: plainArgs(args, password),
          password,
          url,
          ok: outcome.ok,
          ...(locator !== undefined ? { locator } : {}),
          ...(fields !== undefined ? { fields } : {}),
          ...(outcome.error !== undefined ? { error: outcome.error } : {}),
          ...(change !== undefined ? { change } : {}),
        });
      } catch {
        // Journal write failures are dropped; the tool already ran.
      }
    };
  } catch {
    return undefined;
  }
};
