import type { BrowserClient } from "../client";
import type { CdpMethod, ParamsOf, ResultOf } from "../cdp/commands";
import { type Result, err } from "../util/result";
import type { ToolErr } from "../util/tool";

export const cdpCall = async <M extends CdpMethod>(
  client: BrowserClient,
  method: M,
  params: ParamsOf<M>,
): Promise<Result<ResultOf<M>, ToolErr>> => {
  const r = await client.session().call(method, params);
  if (!r.success) return err({ kind: "cdp_error", message: r.error.message, details: { method } });
  return r;
};
