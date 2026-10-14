import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import type { ToolErr } from "../util/tool";
import { boxOf } from "./box";
import { resolveRefToBackendId, staleRefError } from "./ref-resolve";

export type PointArgs = {
  readonly ref?: string | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
};

export type ResolvedTarget = {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  readonly ref?: string;
  readonly backendNodeId?: number;
};

export const resolveTarget = async (
  client: BrowserClient,
  args: PointArgs,
): Promise<Result<ResolvedTarget, ToolErr>> => {
  if (args.ref !== undefined) {
    const backendNodeId = resolveRefToBackendId(client, args.ref);
    if (!backendNodeId.success) return backendNodeId;
    const box = await boxOf(client, backendNodeId.data);
    if (!box.success) return err(staleRefError(args.ref));
    return ok({
      x: box.data.cx,
      y: box.data.cy,
      label: `[${args.ref}] (${box.data.cx}, ${box.data.cy})`,
      ref: args.ref,
      backendNodeId: backendNodeId.data,
    });
  }
  if (args.x !== undefined && args.y !== undefined) {
    return ok({ x: args.x, y: args.y, label: `(${args.x}, ${args.y})` });
  }
  return err({ kind: "invalid_state", message: "Provide either `ref` or both `x` and `y`." });
};

export const refreshResolvedTarget = async (
  client: BrowserClient,
  target: ResolvedTarget,
): Promise<Result<ResolvedTarget, ToolErr>> => {
  if (target.backendNodeId === undefined) return ok(target);
  const box = await boxOf(client, target.backendNodeId);
  if (!box.success) return err(staleRefError(target.ref));
  return ok({
    ...target,
    x: box.data.cx,
    y: box.data.cy,
    label: `[${target.ref}] (${box.data.cx}, ${box.data.cy})`,
  });
};
