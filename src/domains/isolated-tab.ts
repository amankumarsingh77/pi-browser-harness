/**
 * Isolated-attach tab lifecycle (ADR-0002 v1). Opens a harness-owned tab,
 * attaches to it by its own CDP sessionId, and drives it via callOnTarget /
 * evaluateJs(expr, sid) WITHOUT ever touching the global "current" tab — so a
 * search or page-read never disturbs the tab the user is looking at, even when
 * several subagents run concurrently.
 *
 * Mirrors the create/attach sequence in browser_open_urls
 * (src/domains/navigate.ts:84-139). Every page evaluation is bounded by a
 * timeout, so a JS dialog on the (uninstrumented) isolated tab surfaces as a
 * typed timeout rather than hanging — see the dialog-hang caveat in plan.md.
 */
import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import { safeJs } from "../util/js-template";
import type { ToolErr } from "../util/tool";

/** A tab attached by its own sessionId, ready to drive via callOnTarget. */
export type IsolatedTab = {
  readonly targetId: string;
  readonly sessionId: string;
};

const EVAL_TIMEOUT_MS = 15_000;
const READY_POLL_INTERVAL_MS = 50;

const toToolErr = (message: string, kind: ToolErr["kind"] = "cdp_error"): ToolErr => ({ kind, message });

/**
 * Open a harness-owned tab and attach to it, returning its targetId + private
 * sessionId. Does not navigate. The caller MUST `closeIsolatedTab` when done.
 */
export const openIsolatedTab = async (client: BrowserClient): Promise<Result<IsolatedTab, ToolErr>> => {
  const hw = client.ownership().harnessWindow();
  const createParams: Record<string, unknown> = hw
    ? { url: "about:blank", openerId: hw }
    : { url: "about:blank", newWindow: true };

  const created = await client.session().callBrowser("Target.createTarget", createParams);
  if (!created.success) return err(toToolErr(created.error.message));
  const { targetId } = created.data as { targetId: string };

  if (createParams["newWindow"]) client.ownership().setHarnessWindow(targetId);
  client.ownership().add(targetId);

  const attached = await client.session().callBrowser("Target.attachToTarget", { targetId, flatten: true });
  if (!attached.success) {
    await client.closeTab(targetId);
    return err(toToolErr(attached.error.message));
  }
  const { sessionId } = attached.data as { sessionId: string };

  const enabled = await client.session().callOnTarget("Page.enable", {}, sessionId);
  if (!enabled.success) {
    await client.closeTab(targetId);
    return err(toToolErr(enabled.error.message));
  }
  return ok({ targetId, sessionId });
};

/** Navigate an isolated tab to a URL (does not wait for load). */
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

/** Poll the isolated tab until document.readyState === 'complete' or timeout. */
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

/**
 * Evaluate an expression in the isolated tab and return the raw value. Bounds
 * the eval with a timeout so a blocking dialog cannot hang the tool.
 */
export const evalInIsolatedTab = async (
  client: BrowserClient,
  tab: IsolatedTab,
  expression: string,
): Promise<Result<unknown, ToolErr>> => {
  const r = await client.session().callOnTarget(
    "Runtime.evaluate",
    { expression, returnByValue: true, awaitPromise: true },
    tab.sessionId,
    { timeoutMs: EVAL_TIMEOUT_MS },
  );
  if (!r.success) return err(toToolErr(r.error.message, r.error.kind === "timeout" ? "timeout" : "cdp_error"));
  const data = r.data as { result?: { value?: unknown }; exceptionDetails?: unknown };
  if (data.exceptionDetails) {
    return err(toToolErr(`page evaluation failed: ${JSON.stringify(data.exceptionDetails)}`));
  }
  return ok(data.result?.value);
};

/** Close an isolated tab and drop its ownership. Best-effort; never throws. */
export const closeIsolatedTab = async (client: BrowserClient, tab: IsolatedTab): Promise<void> => {
  await client.closeTab(tab.targetId).catch(() => {});
};
