import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import type { ToolErr } from "../util/tool";
import { type Box, boxOf } from "./box";
import { buildTree, collectInteractiveTargets, type SlimNode } from "./snapshot";

const staleErr = (ref: string): ToolErr => ({
  kind: "invalid_state",
  message: `Ref ${ref} is unknown or stale — re-run browser_snapshot to get fresh refs.`,
  details: { ref },
});

export const resolveRefToObjectId = async (
  client: BrowserClient,
  ref: string,
): Promise<Result<string, ToolErr>> => {
  const backendId = client.session().resolveRef(ref);
  if (backendId === undefined) return err(staleErr(ref));
  const resolved = await client.session().call("DOM.resolveNode", { backendNodeId: backendId });
  if (!resolved.success) {
    return err(staleErr(ref));
  }
  const objectId = resolved.data.object.objectId;
  if (!objectId) return err(staleErr(ref));
  return ok(objectId);
};

export const resolveRefToBackendId = (client: BrowserClient, ref: string): Result<number, ToolErr> => {
  const backendId = client.session().resolveRef(ref);
  if (backendId === undefined) return err(staleErr(ref));
  return ok(backendId);
};

export const resolveRefToBox = async (
  client: BrowserClient,
  ref: string,
): Promise<Result<Box, ToolErr>> => {
  const backendId = client.session().resolveRef(ref);
  if (backendId === undefined) return err(staleErr(ref));
  const box = await boxOf(client, backendId);
  if (!box.success) return err(staleErr(ref));
  return ok(box.data);
};

const sigOf = (n: SlimNode): string => `${n.role}|${n.name ?? ""}|${n.value ?? ""}|${n.state ?? ""}`;
const keyOf = (n: SlimNode): string => `${n.role}|${n.name ?? ""}`;

export const interactiveDiff = async (client: BrowserClient): Promise<string> => {
  const session = client.session();
  const prev = session.refSignatures();

  const axRes = await session.call("Accessibility.getFullAXTree", {});
  if (!axRes.success) return "";
  const rawNodes = axRes.data.nodes;
  const slim = buildTree(rawNodes, { interestingOnly: true, maxNodes: 1000 });
  const targets = collectInteractiveTargets(slim);

  const priorRefs = session.refMappings();
  const refByBackendId = new Map<number, string>();
  for (const [ref, backendId] of priorRefs) refByBackendId.set(backendId, ref);
  let nextIndex = 1;
  for (const ref of priorRefs.keys()) {
    const digits = /^e(\d+)$/.exec(ref)?.[1];
    if (digits !== undefined) nextIndex = Math.max(nextIndex, Number(digits) + 1);
  }
  const refMap = new Map<string, number>();
  const refSig = new Map<string, string>();
  const taken = new Set<string>();
  for (const { node, backendId } of targets) {
    const prior = refByBackendId.get(backendId);
    const ref = prior !== undefined && !taken.has(prior) ? prior : `e${nextIndex++}`;
    taken.add(ref);
    node.ref = ref;
    refMap.set(ref, backendId);
    refSig.set(ref, sigOf(node));
  }
  session.setRefMap(refMap, refSig);

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
