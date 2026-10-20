import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import type { ToolErr } from "../util/tool";
import { evalJs } from "./cdp-call";

export type PollOptions = {
  readonly timeoutMs: number;
  readonly signal?: AbortSignal | undefined;
  readonly sessionId?: string | undefined;
  readonly intervalMs?: number | undefined;
  // Names the condition in the timeout message, e.g. "page load".
  readonly what?: string | undefined;
};

const DEFAULT_INTERVAL_MS = 50;

// Resolves (never rejects) after `ms`, or as soon as `signal` aborts.
export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve) => {
    if (signal?.aborted) {
      resolve();
      return;
    }
    const onAbort = (): void => {
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

// Evaluates `expression` in the page until it yields `true`. A deadline or an abort both surface as kind "timeout";
// evaluation errors (e.g. mid-navigation) are retried until the deadline.
export const pollUntil = async (
  client: BrowserClient,
  expression: string,
  opts: PollOptions,
): Promise<Result<{ readonly elapsedMs: number }, ToolErr>> => {
  const start = Date.now();
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const what = opts.what ?? "condition";
  const seconds = Math.round(opts.timeoutMs / 100) / 10;
  while (Date.now() - start < opts.timeoutMs) {
    if (opts.signal?.aborted) {
      return err({ kind: "timeout", message: `Aborted while waiting for ${what}` });
    }
    const r = await evalJs(client, expression, opts.sessionId);
    if (r.success && r.data === true) return ok({ elapsedMs: Date.now() - start });
    await sleep(interval, opts.signal);
  }
  return err({ kind: "timeout", message: `Timed out after ${seconds}s waiting for ${what}` });
};

export const READY_STATE_COMPLETE = `document.readyState === "complete"`;
