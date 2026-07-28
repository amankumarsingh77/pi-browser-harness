import type { AxNodeResult } from "../cdp/commands";
import type { BrowserClient } from "../client";
import type { Box } from "./box";
import { cdpCall } from "./cdp-call";

export type RawAxNode = AxNodeResult;
type AxValue = NonNullable<RawAxNode["role"]>;

export type SlimNode = {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  state?: string;
  children: SlimNode[];
  _backendId?: number;
  ref?: string;
  box?: Box;
};

export const INTERACTIVE_ROLES = new Set([
  "button",
  "link",
  "textbox",
  "checkbox",
  "radio",
  "combobox",
  "menuitem",
  "tab",
  "switch",
  "slider",
  "searchbox",
  "spinbutton",
]);

// The AX `value` is stale for freshly-typed or controlled inputs, so for these roles the live DOM property is read instead.
export const VALUE_ROLES = new Set([
  "textbox",
  "searchbox",
  "spinbutton",
  "combobox",
  "checkbox",
  "radio",
  "switch",
  "slider",
]);

const stringOf = (v: AxValue | undefined): string | undefined => {
  const x = v?.value;
  if (typeof x === "string" && x !== "") return x;
  if (typeof x === "number") return String(x);
  return undefined;
};

const collectState = (props: RawAxNode["properties"]): string | undefined => {
  if (!props || props.length === 0) return undefined;
  const flags: string[] = [];
  for (const p of props) {
    const name = p.name;
    if (!name) continue;
    const raw = p.value?.value;
    if (raw === true && (name === "focused" || name === "required" || name === "disabled" || name === "checked" || name === "expanded" || name === "selected" || name === "pressed" || name === "modal")) {
      flags.push(name);
    }
    if (typeof raw === "number" && name === "level") flags.push(`level ${raw}`);
  }
  return flags.length > 0 ? flags.join(", ") : undefined;
};

export const buildTree = (
  rawNodes: ReadonlyArray<RawAxNode>,
  opts: { interestingOnly: boolean; maxNodes: number },
): SlimNode[] => {
  const byId = new Map<string, RawAxNode>();
  for (const n of rawNodes) byId.set(n.nodeId, n);

  const rootIds: string[] = [];
  for (const n of rawNodes) {
    if (!n.parentId || !byId.has(n.parentId)) rootIds.push(n.nodeId);
  }

  let budget = opts.maxNodes;

  const slim = (node: RawAxNode): SlimNode | undefined => {
    if (budget <= 0) return undefined;
    if (opts.interestingOnly && node.ignored) {
      // Chrome often ignores wrapper divs while their descendants remain meaningful, so recurse through an ignored node's children.
      const out: SlimNode[] = [];
      for (const cid of node.childIds ?? []) {
        const child = byId.get(cid);
        if (!child) continue;
        const slimChild = slim(child);
        if (slimChild) out.push(slimChild);
      }
      return out.length > 0 ? { role: "_hoist", children: out } : undefined;
    }
    budget--;
    const role = stringOf(node.role) ?? "unknown";
    const name = stringOf(node.name);
    const value = stringOf(node.value);
    const description = stringOf(node.description);
    const state = collectState(node.properties);
    const children: SlimNode[] = [];
    for (const cid of node.childIds ?? []) {
      const child = byId.get(cid);
      if (!child) continue;
      const slimChild = slim(child);
      if (!slimChild) continue;
      if (slimChild.role === "_hoist") children.push(...slimChild.children);
      else children.push(slimChild);
    }
    const out: SlimNode = { role, children };
    if (name !== undefined) out.name = name;
    if (value !== undefined) out.value = value;
    if (description !== undefined) out.description = description;
    if (state !== undefined) out.state = state;
    if (node.backendDOMNodeId !== undefined) out._backendId = node.backendDOMNodeId;
    return out;
  };

  const result: SlimNode[] = [];
  for (const rid of rootIds) {
    const root = byId.get(rid);
    if (!root) continue;
    const s = slim(root);
    if (!s) continue;
    if (s.role === "_hoist") result.push(...s.children);
    else result.push(s);
  }
  return result;
};

export const countNodes = (nodes: ReadonlyArray<SlimNode>): number => {
  let n = 0;
  for (const node of nodes) n += 1 + countNodes(node.children);
  return n;
};

export const stripInternals = (nodes: ReadonlyArray<SlimNode>): SlimNode[] =>
  nodes.map((n) => {
    const { _backendId: _bid, ...rest } = n;
    return { ...rest, children: stripInternals(n.children) };
  });

export const collectInteractiveTargets = (
  nodes: ReadonlyArray<SlimNode>,
): Array<{ node: SlimNode; backendId: number }> => {
  const out: Array<{ node: SlimNode; backendId: number }> = [];
  const walk = (ns: ReadonlyArray<SlimNode>): void => {
    for (const n of ns) {
      if (n._backendId !== undefined && INTERACTIVE_ROLES.has(n.role)) {
        out.push({ node: n, backendId: n._backendId });
      }
      walk(n.children);
    }
  };
  walk(nodes);
  return out;
};

export const liveValue = async (client: BrowserClient, backendId: number): Promise<string | undefined> => {
  const resolved = await cdpCall(client, "DOM.resolveNode", { backendNodeId: backendId });
  if (!resolved.success) return undefined;
  const objectId = resolved.data.object.objectId;
  if (!objectId) return undefined;
  const fn = `function () {
    if (this.type === "checkbox" || this.type === "radio") return this.checked ? "checked" : "unchecked";
    if (typeof this.value === "string") return this.value;
    return null;
  }`;
  const r = await cdpCall(client, "Runtime.callFunctionOn", {
    objectId,
    functionDeclaration: fn,
    returnByValue: true,
  });
  if (!r.success) return undefined;
  const value = r.data.result.value;
  return typeof value === "string" ? value : undefined;
};
