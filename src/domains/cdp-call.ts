import type { BrowserClient } from "../client";
import type { CdpMethod, ParamsOf, ResultOf } from "../cdp/commands";
import type { CdpError } from "../cdp/errors";
import type { CallArgs, CallOpts } from "../cdp/session";
import { type Result, err } from "../util/result";
import type { ToolErr } from "../util/tool";

export const cdpErrToToolErr = (e: CdpError, method: string): ToolErr => ({
  kind: e.kind === "timeout" ? "timeout" : "cdp_error",
  message: e.message,
  details: { method },
});

// Maps a BrowserClient-level Result (listTabs, newTab, pageInfo, …) to the tool error shape without losing the
// timeout kind or the CDP method the error carries. `fallbackMethod` names the operation when the error has none.
export const fromClient = <T>(r: Result<T, CdpError>, fallbackMethod = "client"): Result<T, ToolErr> => {
  if (r.success) return r;
  return err(cdpErrToToolErr(r.error, r.error.method ?? fallbackMethod));
};

// Params are required only when the method has a required key, mirroring CdpSession.call.
export const cdpCall = async <M extends CdpMethod>(
  client: BrowserClient,
  method: M,
  ...args: CallArgs<M>
): Promise<Result<ResultOf<M>, ToolErr>> => {
  const r = await client.session().call(method, ...args);
  if (!r.success) return err(cdpErrToToolErr(r.error, method));
  return r;
};

export const cdpCallOnTarget = async <M extends CdpMethod>(
  client: BrowserClient,
  method: M,
  params: ParamsOf<M>,
  sessionId: string,
  opts?: CallOpts,
): Promise<Result<ResultOf<M>, ToolErr>> => {
  const r = await client.session().callOnTarget(method, params, sessionId, opts);
  if (!r.success) return err(cdpErrToToolErr(r.error, method));
  return r;
};

export const cdpCallBrowser = async <M extends CdpMethod>(
  client: BrowserClient,
  method: M,
  ...args: CallArgs<M>
): Promise<Result<ResultOf<M>, ToolErr>> => {
  const r = await client.session().callBrowser(method, ...args);
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
