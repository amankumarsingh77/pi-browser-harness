import { type Result, err, ok } from "../util/result";
import { type CdpError, cdpError } from "./errors";
import type { CdpSession } from "./session";

/**
 * Runtime.evaluate, unwrapped and narrowed. Runs `expression`, surfaces a page
 * exception as an error, then applies `check` to the returned value — the
 * sanctioned way to turn `unknown` evaluate output into a typed `T` without a
 * cast.
 */
export const evaluateJson = async <T>(
  session: CdpSession,
  expression: string,
  check: (v: unknown) => v is T,
): Promise<Result<T, CdpError>> => {
  const r = await session.call("Runtime.evaluate", {
    expression,
    returnByValue: true,
    awaitPromise: true,
  });
  if (!r.success) return r;
  const { result, exceptionDetails } = r.data;
  if (exceptionDetails !== undefined) {
    return err(cdpError("remote_error", exceptionDetails.text, "Runtime.evaluate"));
  }
  const value = result.value;
  if (!check(value)) {
    return err(cdpError("invalid_response", `unexpected evaluate shape for: ${expression.slice(0, 60)}`, "Runtime.evaluate"));
  }
  return ok(value);
};
