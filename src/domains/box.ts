import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import type { ToolErr } from "../util/tool";

export type Box = {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly cx: number;
  readonly cy: number;
};

type BoxModel = {
  readonly content: ReadonlyArray<number>;
  readonly width: number;
  readonly height: number;
};

export const centreOf = (model: BoxModel): Box => {
  const x = model.content[0] ?? 0;
  const y = model.content[1] ?? 0;
  return {
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(model.width),
    height: Math.round(model.height),
    cx: Math.round(x + model.width / 2),
    cy: Math.round(y + model.height / 2),
  };
};

export const boxOf = async (
  client: BrowserClient,
  backendNodeId: number,
): Promise<Result<Box, ToolErr>> => {
  const r = await client.session().call("DOM.getBoxModel", { backendNodeId });
  if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
  const model = r.data.model;
  if (model.content.length < 8) {
    return err({ kind: "invalid_state", message: "DOM.getBoxModel returned an incomplete content quad" });
  }
  if (model.width <= 0 || model.height <= 0) {
    return err({ kind: "invalid_state", message: "element has a zero-size box and cannot be clicked" });
  }
  return ok(centreOf(model));
};
