import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import type { ToolErr } from "../util/tool";
import { buildTree, collectInteractiveTargets, type RawAxNode, type SlimNode } from "./snapshot";

type Box = { x: number; y: number; width: number; height: number; cx: number; cy: number };

const staleErr = (ref: string): ToolErr => ({
  kind: "invalid_state",
  message: `Ref ${ref} is unknown or stale — re-run browser_snapshot to get fresh refs.`,
  details: { ref },
});

/**
 * Resolve a ref to its CDP objectId (a handle to the live JS node). Use when a
 * tool needs to run JS against the element (fill, focus, select, dispatch_key).
 * Re-resolves through the backendNodeId at call time, so it reflects the current
 * DOM even after re-renders — and fails loudly if the node was detached.
 */
export const resolveRefToObjectId = async (
  client: BrowserClient,
  ref: string,
): Promise<Result<string, ToolErr>> => {
  const backendId = client.session().resolveRef(ref);
  if (backendId === undefined) return err(staleErr(ref));
  const resolved = await client.session().call("DOM.resolveNode", { backendNodeId: backendId });
  if (!resolved.success) {
    // A detached node (removed by a re-render) fails to resolve — surface it as
    // a stale ref rather than a raw CDP error so the agent knows to re-snapshot.
    return err(staleErr(ref));
  }
  const objectId = (resolved.data as { object?: { objectId?: string } }).object?.objectId;
  if (!objectId) return err(staleErr(ref));
  return ok(objectId);
};

/** Resolve a ref to its current backendNodeId (for CDP calls that take one, e.g. DOM.setFileInputFiles). */
export const resolveRefToBackendId = (client: BrowserClient, ref: string): Result<number, ToolErr> => {
  const backendId = client.session().resolveRef(ref);
  if (backendId === undefined) return err(staleErr(ref));
  return ok(backendId);
};

/**
 * Resolve a ref to the current center of its bounding box, in viewport CSS
 * pixels. Use for browser_click. Fetched fresh via DOM.getBoxModel, so a
 * re-rendered/moved element is clicked at its new position.
 */
export const resolveRefToBox = async (
  client: BrowserClient,
  ref: string,
): Promise<Result<Box, ToolErr>> => {
  const backendId = client.session().resolveRef(ref);
  if (backendId === undefined) return err(staleErr(ref));
  const r = await client.session().call("DOM.getBoxModel", { backendNodeId: backendId });
  if (!r.success) return err(staleErr(ref));
  const data = r.data as { model?: { content?: ReadonlyArray<number>; width?: number; height?: number } };
  const content = data.model?.content;
  if (!content || content.length < 8) return err(staleErr(ref));
  const x = content[0]!;
  const y = content[1]!;
  const width = data.model!.width ?? 0;
  const height = data.model!.height ?? 0;
  if (width <= 0 || height <= 0) return err(staleErr(ref));
  return ok({
    x: Math.round(x),
    y: Math.round(y),
    width: Math.round(width),
    height: Math.round(height),
    cx: Math.round(x + width / 2),
    cy: Math.round(y + height / 2),
  });
};

const sigOf = (n: SlimNode): string => `${n.role}|${n.name ?? ""}|${n.value ?? ""}|${n.state ?? ""}`;
const keyOf = (n: SlimNode): string => `${n.role}|${n.name ?? ""}`;

/**
 * Recompute the interactive elements after a mutation and return a compact,
 * human/LLM-readable diff vs. the prior snapshot's baseline — changed values,
 * newly-appeared elements (marked `*`), and removed ones. Re-publishes the fresh
 * ref map so subsequent ref-based calls target the post-mutation DOM.
 *
 * Deliberately cheap: it re-reads the AX tree (no per-node box fetch — the
 * expensive part of a full snapshot) and emits a few lines, not a full tree, so
 * a long action sequence doesn't blow up the context.
 *
 * Returns "" on any failure or when nothing changed — callers append it only if
 * non-empty, so a diff is best-effort and never blocks the primary action.
 */
export const interactiveDiff = async (client: BrowserClient): Promise<string> => {
  const session = client.session();
  const prev = session.refSignatures();

  const axRes = await session.call("Accessibility.getFullAXTree", {});
  if (!axRes.success) return "";
  const rawNodes = (axRes.data as { nodes: ReadonlyArray<RawAxNode> }).nodes;
  const slim = buildTree(rawNodes, { interestingOnly: true, maxNodes: 1000 });
  const targets = collectInteractiveTargets(slim);

  // Re-publish fresh refs so later ref calls resolve against the new DOM.
  const refMap = new Map<string, number>();
  const refSig = new Map<string, string>();
  targets.forEach(({ node, backendId }, i) => {
    const ref = `e${i + 1}`;
    node.ref = ref;
    refMap.set(ref, backendId);
    refSig.set(ref, sigOf(node));
  });
  session.setRefMap(refMap, refSig);

  // Compare by stable identity (role|name) rather than ref position, since refs
  // renumber when the element set changes. Build prev/current identity → value.
  const prevByKey = new Map<string, string>();
  for (const sig of prev.values()) {
    const parts = sig.split("|");
    prevByKey.set(`${parts[0]}|${parts[1]}`, sig);
  }
  const curByKey = new Map<string, { ref: string; sig: string }>();
  for (const { node } of targets) {
    if (node.ref) curByKey.set(keyOf(node), { ref: node.ref, sig: sigOf(node) });
  }

  const appeared: string[] = [];
  const changed: string[] = [];
  for (const [key, { ref, sig }] of curByKey) {
    const before = prevByKey.get(key);
    if (before === undefined) {
      appeared.push(`  *[${ref}] ${key.replace("|", ' "')}"`);
    } else if (before !== sig) {
      const va = before.split("|")[2] ?? "";
      const vb = sig.split("|")[2] ?? "";
      const sa = before.split("|")[3] ?? "";
      const sb = sig.split("|")[3] ?? "";
      const detail = va !== vb ? `value ${JSON.stringify(va)} → ${JSON.stringify(vb)}` : `state ${JSON.stringify(sa)} → ${JSON.stringify(sb)}`;
      changed.push(`  [${ref}] ${key.replace("|", ' "')}": ${detail}`);
    }
  }
  const removed: string[] = [];
  for (const key of prevByKey.keys()) {
    if (!curByKey.has(key)) removed.push(`  ${key.replace("|", ' "')}"`);
  }

  if (appeared.length === 0 && changed.length === 0 && removed.length === 0) return "";
  const lines: string[] = ["", "Page changes (re-snapshot for full tree):"];
  if (changed.length) lines.push("Changed:", ...changed.slice(0, 12));
  if (appeared.length) lines.push("New (*):", ...appeared.slice(0, 12));
  if (removed.length) lines.push("Removed:", ...removed.slice(0, 8));
  const overflow = Math.max(0, changed.length - 12) + Math.max(0, appeared.length - 12) + Math.max(0, removed.length - 8);
  if (overflow > 0) lines.push(`  …and ${overflow} more (browser_snapshot for full state)`);
  return lines.join("\n");
};
