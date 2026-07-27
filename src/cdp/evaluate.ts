import { type Result, err, ok } from "../util/result";
import { type CdpError, cdpError } from "./errors";
import type { CdpSession } from "./session";

export const evaluateJson = async <T>(
  session: CdpSession,
  expression: string,
  check: (v: unknown) => v is T,
  opts?: { sessionId?: string | undefined; timeoutMs?: number | undefined },
): Promise<Result<T, CdpError>> => {
  const params = {
    expression,
    returnByValue: true,
    awaitPromise: true,
  };
  const callOpts = opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {};
  const r = opts?.sessionId !== undefined
    ? await session.callOnTarget("Runtime.evaluate", params, opts.sessionId, callOpts)
    : await session.call("Runtime.evaluate", params, callOpts);
  if (!r.success) return r;
  const { result, exceptionDetails } = r.data;
  if (exceptionDetails !== undefined) {
    return err(cdpError("remote_error", exceptionDetails.text, "Runtime.evaluate"));
  }
  const value = result.value;
  if (!check(value)) {
    return err(cdpError("invalid_response", `unexpected evaluate shape (type: ${result.type}) for: ${expression.slice(0, 60)}`, "Runtime.evaluate"));
  }
  return ok(value);
};
