import type { BrowserClient } from "../client";
import { isRecord } from "../util/guards";
import { type Result, err, ok } from "../util/result";
import type { ToolErr } from "../util/tool";
import { boxOf } from "./box";
import { cdpCall } from "./cdp-call";
import { hitInfo } from "./page/click.page";
import { elementFunctionSource } from "./page/inject";
import { resolveRefToBackendId } from "./ref-resolve";

export type PointArgs = {
  readonly ref?: string | undefined;
  readonly x?: number | undefined;
  readonly y?: number | undefined;
};

export type ResolvedTarget = {
  readonly x: number;
  readonly y: number;
  readonly label: string;
  // Set when hit-testing found something other than the ref's element under the point (an overlay, a sticky header).
  readonly covered?: string;
  // For an x/y click: what is under the point, so the agent can tell whether it hit what it meant to.
  readonly hit?: string;
};

type Viewport = { readonly width: number; readonly height: number };

// The layout viewport in CSS pixels, or undefined when Chrome would not say (then no bounds check is made).
export const viewportOf = async (client: BrowserClient): Promise<Viewport | undefined> => {
  const r = await cdpCall(client, "Page.getLayoutMetrics", {});
  if (!r.success) return undefined;
  const { clientWidth, clientHeight } = r.data.cssLayoutViewport;
  return clientWidth > 0 && clientHeight > 0 ? { width: clientWidth, height: clientHeight } : undefined;
};

const inside = (vp: Viewport, x: number, y: number): boolean => x >= 0 && y >= 0 && x < vp.width && y < vp.height;

const outsideErr = (x: number, y: number, vp: Viewport, ref?: string): ToolErr => ({
  kind: "invalid_state",
  message: ref !== undefined
    ? `[${ref}] is at (${x}, ${y}), outside the ${vp.width}x${vp.height} viewport even after scrolling it into view — it may be clipped by a scroll container or positioned off-screen. Scroll its container (browser_scroll) and re-snapshot.`
    : `Point (${x}, ${y}) is outside the ${vp.width}x${vp.height} viewport, so the click would hit nothing. Use the element's ref from browser_snapshot instead — browser_click scrolls it into view.`,
  details: { x, y, viewportWidth: vp.width, viewportHeight: vp.height, ...(ref !== undefined ? { ref } : {}) },
});

const HIT_FN = elementFunctionSource(hitInfo);

const isHitInfo = (v: unknown): v is { readonly onTarget: boolean; readonly hit: string } =>
  isRecord(v) && typeof v["onTarget"] === "boolean" && typeof v["hit"] === "string";

// What hit-testing finds at the point, relative to the target element (or just what is there, with no target);
// undefined when it cannot tell.
const hitTest = async (client: BrowserClient, backendId: number | undefined, x: number, y: number): Promise<{ readonly onTarget: boolean; readonly hit: string } | undefined> => {
  const loc = await cdpCall(client, "DOM.getNodeForLocation", { x: Math.round(x), y: Math.round(y), ignorePointerEventsNone: true });
  if (!loc.success) return undefined;
  const target = await cdpCall(client, "DOM.resolveNode", { backendNodeId: backendId ?? loc.data.backendNodeId });
  const hit = await cdpCall(client, "DOM.resolveNode", { backendNodeId: loc.data.backendNodeId });
  const targetId = target.success ? target.data.object.objectId : undefined;
  const hitId = hit.success ? hit.data.object.objectId : undefined;
  try {
    if (targetId === undefined || hitId === undefined) return undefined;
    const called = await cdpCall(client, "Runtime.callFunctionOn", {
      objectId: targetId,
      functionDeclaration: HIT_FN,
      arguments: [{ objectId: hitId }],
      returnByValue: true,
    });
    if (!called.success || called.data.exceptionDetails !== undefined) return undefined;
    const v: unknown = called.data.result.value;
    return isHitInfo(v) ? v : undefined;
  } finally {
    for (const id of [targetId, hitId]) if (id !== undefined) await cdpCall(client, "Runtime.releaseObject", { objectId: id });
  }
};

// Turns a ref (or x/y) into the point a trusted mouse event should land on. For a ref: scroll the element into view
// (nested scroll containers included), measure it now, refuse a point still outside the viewport, and hit-test it so
// a covered element is reported instead of silently clicking whatever is on top.
export const resolveTarget = async (
  client: BrowserClient,
  args: PointArgs,
): Promise<Result<ResolvedTarget, ToolErr>> => {
  if (args.ref !== undefined) {
    const backendId = resolveRefToBackendId(client, args.ref);
    if (!backendId.success) return backendId;
    // A failed scroll is not fatal: the bounds check below catches an element that is still out of view.
    await cdpCall(client, "DOM.scrollIntoViewIfNeeded", { backendNodeId: backendId.data });
    const box = await boxOf(client, backendId.data);
    if (!box.success) {
      return err({ kind: "invalid_state", message: `Ref ${args.ref} is unknown or stale — re-run browser_snapshot to get fresh refs.`, details: { ref: args.ref } });
    }
    const { cx, cy } = box.data;
    const vp = await viewportOf(client);
    if (vp !== undefined && !inside(vp, cx, cy)) return err(outsideErr(cx, cy, vp, args.ref));
    const hit = await hitTest(client, backendId.data, cx, cy);
    return ok({
      x: cx,
      y: cy,
      label: `[${args.ref}] (${cx}, ${cy})`,
      ...(hit !== undefined && !hit.onTarget ? { covered: hit.hit } : {}),
    });
  }
  if (args.x !== undefined && args.y !== undefined) {
    const vp = await viewportOf(client);
    if (vp !== undefined && !inside(vp, args.x, args.y)) return err(outsideErr(args.x, args.y, vp));
    const hit = await hitTest(client, undefined, args.x, args.y);
    return ok({ x: args.x, y: args.y, label: `(${args.x}, ${args.y})`, ...(hit !== undefined ? { hit: hit.hit } : {}) });
  }
  return err({ kind: "invalid_args", message: "Provide either `ref` or both `x` and `y`." });
};
