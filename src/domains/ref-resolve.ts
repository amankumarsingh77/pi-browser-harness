import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import type { ToolErr } from "../util/tool";
import { type Box, boxOf } from "./box";
import { cdpCall } from "./cdp-call";
import { buildTree, collectInteractiveTargets } from "./ax-tree";
import { type RefSignature, signatureOf } from "./ref-signature";

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
  const resolved = await cdpCall(client, "DOM.resolveNode", { backendNodeId: backendId });
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

export type RefRefresh = {
  readonly prev: ReadonlyMap<string, RefSignature>;
  readonly cur: ReadonlyMap<string, RefSignature>;
};

// Re-reads the AX tree and republishes the session's ref map: an element seen before keeps its ref, a new one gets
// the next unused index. Returns the signatures before and after so the caller can diff them.
export const refreshRefs = async (client: BrowserClient): Promise<Result<RefRefresh, ToolErr>> => {
  const session = client.session();
  const prev = session.refSignatures();

  const axRes = await cdpCall(client, "Accessibility.getFullAXTree", {});
  if (!axRes.success) return axRes;
  const slim = buildTree(axRes.data.nodes, { interestingOnly: true, maxNodes: Number.POSITIVE_INFINITY });
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
  const cur = new Map<string, RefSignature>();
  const taken = new Set<string>();
  for (const { node, backendId } of targets) {
    const prior = refByBackendId.get(backendId);
    const ref = prior !== undefined && !taken.has(prior) ? prior : `e${nextIndex++}`;
    taken.add(ref);
    node.ref = ref;
    refMap.set(ref, backendId);
    cur.set(ref, signatureOf(node));
  }
  session.setRefMap(refMap, cur);
  return ok({ prev, cur });
};

const identityKey = (s: RefSignature): string => JSON.stringify([s.role, s.name]);
const describe = (s: RefSignature): string => `${s.role} "${s.name}"`;

// Pure: renders what changed between two signature sets, keyed by role+name. Empty string when nothing changed.
export const diffSignatures = (
  prev: ReadonlyMap<string, RefSignature>,
  cur: ReadonlyMap<string, RefSignature>,
): string => {
  const prevByKey = new Map<string, RefSignature>();
  for (const sig of prev.values()) prevByKey.set(identityKey(sig), sig);
  const curByKey = new Map<string, { readonly ref: string; readonly sig: RefSignature }>();
  for (const [ref, sig] of cur) curByKey.set(identityKey(sig), { ref, sig });

  const appeared: string[] = [];
  const changed: string[] = [];
  for (const [key, { ref, sig }] of curByKey) {
    const before = prevByKey.get(key);
    if (before === undefined) {
      appeared.push(`  *[${ref}] ${describe(sig)}`);
    } else if (before.value !== sig.value) {
      changed.push(`  [${ref}] ${describe(sig)}: value ${JSON.stringify(before.value)} → ${JSON.stringify(sig.value)}`);
    } else if (before.state !== sig.state) {
      changed.push(`  [${ref}] ${describe(sig)}: state ${JSON.stringify(before.state)} → ${JSON.stringify(sig.state)}`);
    }
  }
  const removed: string[] = [];
  for (const [key, sig] of prevByKey) {
    if (!curByKey.has(key)) removed.push(`  ${describe(sig)}`);
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

// Convenience for action tools: refresh refs and append a diff to the action's text. A failed refresh is reported
// inline rather than failing the action that already happened.
export const interactiveDiff = async (client: BrowserClient): Promise<string> => {
  const refreshed = await refreshRefs(client);
  if (!refreshed.success) return `\n(page diff unavailable: ${refreshed.error.message})`;
  return diffSignatures(refreshed.data.prev, refreshed.data.cur);
};
