import type { BrowserClient } from "../client";
import type { CdpMethod, ParamsOf, ResultOf } from "../cdp/commands";
import type { CdpError } from "../cdp/errors";
import { asNumber, asRecord, asString } from "../util/guards";
import { type Result, err } from "../util/result";
import type { ToolErr } from "../util/tool";

export const cdpErrToToolErr = (e: CdpError, method: string): ToolErr => ({
  kind: e.kind === "timeout" ? "timeout" : "cdp_error",
  message: e.message,
  details: { method },
});

// Every tool's mouse dispatch already funnels through cdpCall, so the cursor track is collected here
// rather than in click.ts, scroll.ts and drag.ts separately — one tap instead of four, and a new
// mouse-driven tool is captured without being told to opt in. noteInput is a no-op when nothing is
// recording, so the cost on the normal path is one string comparison.
const noteMouseInput = (client: BrowserClient, method: string, params: unknown): void => {
  if (method !== "Input.dispatchMouseEvent") return;
  const p = asRecord(params);
  if (!p) return;
  const x = asNumber(p["x"]);
  const y = asNumber(p["y"]);
  if (x === undefined || y === undefined) return;
  client.session().noteInput(x, y, asString(p["type"]) === "mousePressed" ? "click" : "move");
};

export const cdpCall = async <M extends CdpMethod>(
  client: BrowserClient,
  method: M,
  params: ParamsOf<M>,
  opts?: { timeoutMs?: number },
): Promise<Result<ResultOf<M>, ToolErr>> => {
  const r = await client.session().call(method, params, opts);
  if (!r.success) return err(cdpErrToToolErr(r.error, method));
  noteMouseInput(client, method, params);
  return r;
};

export const cdpCallOnTarget = async <M extends CdpMethod>(
  client: BrowserClient,
  method: M,
  params: ParamsOf<M>,
  sessionId: string,
  opts?: { timeoutMs?: number },
): Promise<Result<ResultOf<M>, ToolErr>> => {
  const r = await client.session().callOnTarget(method, params, sessionId, opts);
  if (!r.success) return err(cdpErrToToolErr(r.error, method));
  return r;
};

export const cdpCallBrowser = async <M extends CdpMethod>(
  client: BrowserClient,
  method: M,
  params?: ParamsOf<M>,
  opts?: { timeoutMs?: number },
): Promise<Result<ResultOf<M>, ToolErr>> => {
  const r = await client.session().callBrowser(method, params, opts);
  if (!r.success) return err(cdpErrToToolErr(r.error, method));
  return r;
};

export const evalJs = async (
  client: BrowserClient,
  expression: string,
  sessionId?: string,
): Promise<Result<unknown, ToolErr>> => {
  const r = await client.evaluateJs(expression, sessionId);
  if (!r.success) return err(cdpErrToToolErr(r.error, "Runtime.evaluate"));
  return r;
};
