import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import { safeJs } from "../util/js-template";
import { ensureHarnessWindow, openHarnessTab } from "../cdp/target-factory";
import { evaluateJson } from "../cdp/evaluate";
import type { ToolErr } from "../util/tool";
import { cdpCallBrowser, cdpCallOnTarget, cdpErrToToolErr, evalJs } from "./cdp-call";

export type IsolatedTab = {
  readonly targetId: string;
  readonly sessionId: string;
};

const EVAL_TIMEOUT_MS = 15_000;
const READY_POLL_INTERVAL_MS = 50;

export const openIsolatedTab = async (client: BrowserClient): Promise<Result<IsolatedTab, ToolErr>> => {
  // Routed through the target factory so an isolated tab lands in the pinned profile, not another profile's cookies.
  const window = await ensureHarnessWindow(client);
  if (!window.success) return err(cdpErrToToolErr(window.error, "Target.createTarget"));
  let targetId: string;
  if (window.data.freshlyCreated) {
    targetId = window.data.targetId;
  } else {
    const opened = await openHarnessTab(client, window.data.targetId);
    if (!opened.success) return err(cdpErrToToolErr(opened.error, "Target.createTarget"));
    targetId = opened.data;
  }

  const attached = await cdpCallBrowser(client, "Target.attachToTarget", { targetId, flatten: true });
  if (!attached.success) {
    await client.closeTab(targetId);
    return attached;
  }
  const { sessionId } = attached.data;

  const enabled = await cdpCallOnTarget(client, "Page.enable", {}, sessionId);
  if (!enabled.success) {
    await client.closeTab(targetId);
    return enabled;
  }
  return ok({ targetId, sessionId });
};

export const navigateIsolatedTab = async (
  client: BrowserClient,
  tab: IsolatedTab,
  url: string,
): Promise<Result<void, ToolErr>> => {
  const nav = await cdpCallOnTarget(client, "Page.navigate", { url }, tab.sessionId, {
    timeoutMs: EVAL_TIMEOUT_MS,
  });
  if (!nav.success) return nav;
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
    if (signal?.aborted) return err({ kind: "internal", message: "aborted" });
    const r = await evalJs(client, safeJs`document.readyState`, tab.sessionId);
    if (r.success && r.data === "complete") return ok(undefined);
    await new Promise((res) => setTimeout(res, READY_POLL_INTERVAL_MS));
  }
  return err({ kind: "timeout", message: `page did not finish loading in ${Math.round(timeoutMs / 1000)}s` });
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
  if (!r.success) return err(cdpErrToToolErr(r.error, "Runtime.evaluate"));
  return ok(r.data);
};

export const closeIsolatedTab = async (client: BrowserClient, tab: IsolatedTab): Promise<void> => {
  await client.closeTab(tab.targetId).catch(() => {});
};
