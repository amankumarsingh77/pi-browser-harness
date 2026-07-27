import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import type { ToolErr } from "../util/tool";
import { resolveRefToBox } from "./ref-resolve";

export type PointArgs = {
  readonly ref?: string | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
};

export type ResolvedTarget = {
  readonly x: number;
  readonly y: number;
  readonly label: string;
};

export const resolveTarget = async (
  client: BrowserClient,
  args: PointArgs,
): Promise<Result<ResolvedTarget, ToolErr>> => {
  if (args.ref !== undefined) {
    const box = await resolveRefToBox(client, args.ref);
    if (!box.success) return box;
    return ok({
      x: box.data.cx,
      y: box.data.cy,
      label: `[${args.ref}] (${box.data.cx}, ${box.data.cy})`,
    });
  }
  if (args.x !== undefined && args.y !== undefined) {
    return ok({ x: args.x, y: args.y, label: `(${args.x}, ${args.y})` });
  }
  return err({ kind: "invalid_state", message: "Provide either `ref` or both `x` and `y`." });
};
