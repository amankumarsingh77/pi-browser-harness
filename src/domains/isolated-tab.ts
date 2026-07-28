import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import { safeJs } from "../util/js-template";
import { ensureHarnessWindow, openHarnessTab } from "../cdp/target-factory";
import { evaluateJson } from "../cdp/evaluate";
import type { ToolErr } from "../util/tool";

export type IsolatedTab = {
  readonly targetId: string;
  readonly sessionId: string;
};

const EVAL_TIMEOUT_MS = 15_000;
const READY_POLL_INTERVAL_MS = 50;

const toToolErr = (message: string, kind: ToolErr["kind"] = "cdp_error"): ToolErr => ({ kind, message });

export const openIsolatedTab = async (client: BrowserClient): Promise<Result<IsolatedTab, ToolErr>> => {
  // Routed through the target factory so an isolated tab lands in the pinned profile, not another profile's cookies.
  const window = await ensureHarnessWindow(client);
  if (!window.success) return err(toToolErr(window.error.message));
  let targetId: string;
  if (window.data.freshlyCreated) {
    targetId = window.data.targetId;
  } else {
    const opened = await openHarnessTab(client, window.data.targetId);
    if (!opened.success) return err(toToolErr(opened.error.message));
    targetId = opened.data;
  }

  const attached = await client.session().callBrowser("Target.attachToTarget", { targetId, flatten: true });
  if (!attached.success) {
    await client.closeTab(targetId);
    return err(toToolErr(attached.error.message));
  }
  const { sessionId } = attached.data;

  const enabled = await client.session().callOnTarget("Page.enable", {}, sessionId);
  if (!enabled.success) {
    await client.closeTab(targetId);
    return err(toToolErr(enabled.error.message));
  }
  return ok({ targetId, sessionId });
};

export const navigateIsolatedTab = async (
  client: BrowserClient,
  tab: IsolatedTab,
  url: string,
): Promise<Result<void, ToolErr>> => {
  const nav = await client.session().callOnTarget("Page.navigate", { url }, tab.sessionId, {
    timeoutMs: EVAL_TIMEOUT_MS,
  });
  if (!nav.success) return err(toToolErr(nav.error.message));
  return ok(undefined);
};

export const waitForIsolatedLoad = async (
  client: BrowserClient,
  tab: IsolatedTab,
  timeoutMs: number,
  signal?: AbortSignal,
): Promise<Result<void, ToolErr>> => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    if (signal?.aborted) return err(toToolErr("aborted", "internal"));
    const r = await client.evaluateJs(safeJs`document.readyState`, tab.sessionId);
    if (r.success && r.data === "complete") return ok(undefined);
    await new Promise((res) => setTimeout(res, READY_POLL_INTERVAL_MS));
  }
  return err(toToolErr(`page did not finish loading in ${Math.round(timeoutMs / 1000)}s`, "timeout"));
};

export const isJsonText = (v: unknown): v is string => typeof v === "string";

export const evalInIsolatedTab = async <T>(
  client: BrowserClient,
  tab: IsolatedTab,
  expression: string,
  check: (v: unknown) => v is T,
): Promise<Result<T, ToolErr>> => {
  const r = await evaluateJson(client.session(), expression, check, {
    sessionId: tab.sessionId,
    timeoutMs: EVAL_TIMEOUT_MS,
  });
  if (!r.success) return err(toToolErr(r.error.message, r.error.kind === "timeout" ? "timeout" : "cdp_error"));
  return ok(r.data);
};

export const closeIsolatedTab = async (client: BrowserClient, tab: IsolatedTab): Promise<void> => {
  await client.closeTab(tab.targetId).catch(() => {});
};
