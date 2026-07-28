import type { BrowserClient } from "../client";
import type { CdpMethod, ParamsOf, ResultOf } from "../cdp/commands";
import type { CdpError } from "../cdp/errors";
import { type Result, err } from "../util/result";
import type { ToolErr } from "../util/tool";

export const cdpErrToToolErr = (e: CdpError, method: string): ToolErr => ({
  kind: e.kind === "timeout" ? "timeout" : "cdp_error",
  message: e.message,
  details: { method },
});

export const cdpCall = async <M extends CdpMethod>(
  client: BrowserClient,
  method: M,
  params: ParamsOf<M>,
  opts?: { timeoutMs?: number },
): Promise<Result<ResultOf<M>, ToolErr>> => {
  const r = await client.session().call(method, params, opts);
  if (!r.success) return err(cdpErrToToolErr(r.error, method));
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
