import { readFileSync, writeFileSync } from "node:fs";
import { Type } from "typebox";
import { Container, Image, type ImageTheme, Markdown, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { applyTruncation } from "../util/truncate";
import { screenshotPath } from "../util/paths";

const SnapshotArgs = Type.Object({
  includeScreenshot: Type.Optional(
    Type.Boolean({ default: false, description: "Also capture a JPEG screenshot of the current viewport." }),
  ),
  interestingOnly: Type.Optional(
    Type.Boolean({ default: true, description: "Drop nodes the AX engine marked uninteresting (generic containers, inline text, etc.)." }),
  ),
  maxNodes: Type.Optional(
    Type.Integer({ default: 1000, minimum: 1, maximum: 5000, description: "Cap on slim nodes returned." }),
  ),
  format: Type.Optional(
    Type.Union(
      [Type.Literal("outline"), Type.Literal("json")],
      { default: "outline", description: "'outline' = indented markdown bullet tree; 'json' = raw slim structure." },
    ),
  ),
});

// Raw shapes from CDP Accessibility.getFullAXTree. Cast at this boundary only.
type AxValue = { value?: unknown };
type RawAxNode = {
  nodeId: string;
  parentId?: string;
  childIds?: ReadonlyArray<string>;
  ignored?: boolean;
  role?: AxValue;
  name?: AxValue;
  value?: AxValue;
  description?: AxValue;
  properties?: ReadonlyArray<{ name?: string; value?: AxValue }>;
  backendDOMNodeId?: number;
};

type Box = { x: number; y: number; width: number; height: number; cx: number; cy: number };

type SlimNode = {
  role: string;
  name?: string;
  value?: string;
  description?: string;
  state?: string;
  children: SlimNode[];
  /** Internal: kept for the post-build box fetch. Stripped before returning to the LLM. */
  _backendId?: number;
  /** Click target — center of the element's bounding box, in viewport CSS pixels. */
  box?: Box;
};

const INTERACTIVE_ROLES = new Set([
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
    // Boolean flags worth surfacing in the outline.
    if (raw === true && (name === "focused" || name === "required" || name === "disabled" || name === "checked" || name === "expanded" || name === "selected" || name === "pressed" || name === "modal")) {
      flags.push(name);
    }
    if (typeof raw === "number" && name === "level") flags.push(`level ${raw}`);
  }
  return flags.length > 0 ? flags.join(", ") : undefined;
};

const buildTree = (
  rawNodes: ReadonlyArray<RawAxNode>,
  opts: { interestingOnly: boolean; maxNodes: number },
): SlimNode[] => {
  // Index for parent/child lookups.
  const byId = new Map<string, RawAxNode>();
  for (const n of rawNodes) byId.set(n.nodeId, n);

  // CDP doesn't mark a single root explicitly; the root nodes are the ones
  // whose parentId isn't in the index (typically just one — RootWebArea).
  const rootIds: string[] = [];
  for (const n of rawNodes) {
    if (!n.parentId || !byId.has(n.parentId)) rootIds.push(n.nodeId);
  }

  let budget = opts.maxNodes;

  const slim = (node: RawAxNode): SlimNode | undefined => {
    if (budget <= 0) return undefined;
    if (opts.interestingOnly && node.ignored) {
      // Skip the ignored node but recurse through its children — Chrome often
      // ignores wrapper divs but the meaningful descendants are still there.
      const out: SlimNode[] = [];
      for (const cid of node.childIds ?? []) {
        const child = byId.get(cid);
        if (!child) continue;
        const slimChild = slim(child);
        if (slimChild) out.push(slimChild);
      }
      // Hoist children into the parent. We return undefined; the parent's
      // recursion will see them by re-walking — but that double-counts. Instead
      // we handle hoisting at the parent level. So here just signal "skip me"
      // by returning undefined; the parent will hoist by checking ignored flag.
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
      // Hoist any synthetic _hoist nodes' children into this level.
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

const countNodes = (nodes: ReadonlyArray<SlimNode>): number => {
  let n = 0;
  for (const node of nodes) n += 1 + countNodes(node.children);
  return n;
};

const summarize = (nodes: ReadonlyArray<SlimNode>): string => {
  const counts = new Map<string, number>();
  const walk = (ns: ReadonlyArray<SlimNode>): void => {
    for (const n of ns) {
      counts.set(n.role, (counts.get(n.role) ?? 0) + 1);
      walk(n.children);
    }
  };
  walk(nodes);
  // Group landmarks (roles that are top-level structural).
  const landmarkRoles = new Set(["banner", "navigation", "main", "complementary", "contentinfo", "search", "form", "region"]);
  let landmarks = 0;
  for (const [role, c] of counts) if (landmarkRoles.has(role)) landmarks += c;
  const buttons = counts.get("button") ?? 0;
  const inputs = (counts.get("textbox") ?? 0) + (counts.get("combobox") ?? 0) + (counts.get("checkbox") ?? 0);
  const links = counts.get("link") ?? 0;
  const parts: string[] = [];
  if (landmarks > 0) parts.push(`${landmarks} landmark${landmarks === 1 ? "" : "s"}`);
  if (buttons > 0) parts.push(`${buttons} button${buttons === 1 ? "" : "s"}`);
  if (inputs > 0) parts.push(`${inputs} input${inputs === 1 ? "" : "s"}`);
  if (links > 0) parts.push(`${links} link${links === 1 ? "" : "s"}`);
  return parts.join(" · ");
};

const renderOutline = (nodes: ReadonlyArray<SlimNode>): string => {
  const lines: string[] = [];
  const walk = (ns: ReadonlyArray<SlimNode>, depth: number): void => {
    for (const n of ns) {
      const indent = "  ".repeat(depth);
      let line = `${indent}- ${n.role}`;
      if (n.name) line += ` "${n.name}"`;
      if (n.value && n.value !== n.name) line += ` = ${JSON.stringify(n.value)}`;
      if (n.state) line += ` (${n.state})`;
      // Surface click coordinates for interactive nodes — agents can pass these
      // straight to browser_click without a screenshot round-trip.
      if (n.box && INTERACTIVE_ROLES.has(n.role)) {
        line += ` @(${n.box.cx},${n.box.cy})`;
      }
      lines.push(line);
      walk(n.children, depth + 1);
    }
  };
  walk(nodes, 0);
  return lines.join("\n");
};

/** Strip internal _backendId from a slim tree before returning to callers. */
const stripInternals = (nodes: ReadonlyArray<SlimNode>): SlimNode[] =>
  nodes.map((n) => {
    const { _backendId: _bid, ...rest } = n;
    return { ...rest, children: stripInternals(n.children) };
  });

/**
 * Walk all slim nodes and collect (slimNode, backendId) pairs for interactive
 * roles. Caller fetches DOM.getBoxModel for each and writes box back into the
 * slim node by reference.
 */
const collectInteractiveTargets = (
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

type SnapshotDetails = {
  nodeCount: number;
  truncated: boolean;
  fullOutputPath?: string;
  screenshotPath?: string;
  url: string;
  title: string;
};

export const snapshotTool = defineBrowserTool({
  name: "browser_snapshot",
  label: "Browser Snapshot",
  description:
    "DEFAULT tool for understanding what is on the page. Returns the structured accessibility tree (roles, names, states, hierarchy) plus click coordinates for every interactive element as @(x,y). Use this BEFORE deciding whether you need a screenshot — almost always sufficient on its own and far cheaper. Pair with browser_execute_js for surgical reads of specific element values.",
  promptSnippet: "Get accessibility-tree snapshot of the current page (default for page inspection)",
  promptGuidelines: [
    "DEFAULT — use this whenever you need to know what's on a page, what's clickable, or how the page is structured.",
    "Click coordinates come for free: every interactive element shows '@(x,y)' in the outline. Pass these straight to browser_click. NO screenshot round-trip needed.",
    "DO NOT call browser_screenshot just to understand the page. This tool already gives you structure, labels, states, and click targets.",
    "Pass includeScreenshot:true ONLY if you also need to verify visual rendering (rare).",
    "format:'json' returns the raw slim structure (with `box` per node) for programmatic use; default 'outline' is human/LLM-readable.",
  ],
  parameters: SnapshotArgs,

  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const session = client.session();

    // 1. AX tree
    const axRes = await session.call("Accessibility.getFullAXTree", {});
    if (!axRes.success) return err({ kind: "cdp_error", message: axRes.error.message });
    const rawNodes = (axRes.data as { nodes: ReadonlyArray<RawAxNode> }).nodes;

    // 2. Page url/title
    const piRes = await client.pageInfo();
    if (!piRes.success) return err({ kind: "cdp_error", message: piRes.error.message });
    const pageUrl = "dialog" in piRes.data ? "" : piRes.data.url;
    const pageTitle = "dialog" in piRes.data ? "" : piRes.data.title;

    // 3. Slim + format
    const slim = buildTree(rawNodes, {
      interestingOnly: args.interestingOnly ?? true,
      maxNodes: args.maxNodes ?? 1000,
    });

    // 4. Fetch bounding boxes for interactive nodes so the agent can click
    //    without a screenshot round-trip. Capped budget so a slow page can't
    //    wedge the call.
    const targets = collectInteractiveTargets(slim);
    if (targets.length > 0) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), 1_500);
      await Promise.allSettled(
        targets.map(async ({ node, backendId }) => {
          if (ac.signal.aborted) return;
          const r = await session.call("DOM.getBoxModel", { backendNodeId: backendId });
          if (!r.success) return;
          // CDP boundary cast: DOM.getBoxModel
          const data = r.data as { model?: { content?: ReadonlyArray<number>; width?: number; height?: number } };
          const content = data.model?.content;
          if (!content || content.length < 8) return;
          // content is [x1,y1, x2,y1, x2,y2, x1,y2] in viewport CSS pixels.
          const x = content[0]!;
          const y = content[1]!;
          const width = data.model!.width ?? 0;
          const height = data.model!.height ?? 0;
          // Skip zero-size and off-viewport boxes — they can't be clicked.
          if (width <= 0 || height <= 0 || x < 0 || y < 0) return;
          node.box = {
            x: Math.round(x),
            y: Math.round(y),
            width: Math.round(width),
            height: Math.round(height),
            cx: Math.round(x + width / 2),
            cy: Math.round(y + height / 2),
          };
        }),
      );
      clearTimeout(timer);
    }

    const stripped = stripInternals(slim);
    const text = (args.format ?? "outline") === "outline" ? renderOutline(slim) : JSON.stringify(stripped, null, 2);
    const trunc = await applyTruncation(text, "snapshot");

    // 4. Optional screenshot — JPEG q=80 to match screenshotTool's default.
    let shotPath: string | undefined;
    if (args.includeScreenshot) {
      const shot = await session.call("Page.captureScreenshot", { format: "jpeg", quality: 80 });
      if (shot.success) {
        const data = (shot.data as { data: string }).data;
        shotPath = screenshotPath(client.namespace, "jpeg");
        writeFileSync(shotPath, Buffer.from(data, "base64"));
      }
    }

    const details: SnapshotDetails = {
      nodeCount: countNodes(slim),
      truncated: trunc.wasTruncated,
      url: pageUrl,
      title: pageTitle,
    };
    if (trunc.fullOutputPath !== undefined) details.fullOutputPath = trunc.fullOutputPath;
    if (shotPath !== undefined) details.screenshotPath = shotPath;

    return ok({ text: trunc.text, details: { ...details, summary: summarize(slim) } });
  },

  renderResult(result, expanded, theme) {
    const details = result.details as
      | (SnapshotDetails & { summary?: string; ok?: boolean })
      | undefined;
    if (!details) return new Text(theme.fg("error", "snapshot: no details"), 0, 0);

    const titleLine = details.title ? ` "${details.title}"` : "";
    const summary = details.summary ?? "";
    const screenshotNote = details.screenshotPath ? "screenshot attached" : "screenshot omitted";
    const truncNote = details.truncated && details.fullOutputPath ? `\n\nFull tree at \`${details.fullOutputPath}\`` : "";

    if (!expanded) {
      const md = [
        `**AX tree:** ${details.nodeCount} nodes · \`${details.url || "(no url)"}\``,
        `${titleLine ? "  " + titleLine : ""}`,
        summary ? `  • ${summary}` : "",
        `  ${keyHint("app.tools.expand", "to expand")} · ${screenshotNote}`,
      ].filter((l) => l !== "").join("\n");
      return new Markdown(md, 0, 0, getMarkdownTheme());
    }

    // Expanded view: read truncated text from result.content (the spilled file
    // is too large to inline) — the same `text` we returned from handler is in
    // result.content[0]. Fall back to a placeholder if shape is unexpected.
    const content = result.content[0];
    const treeText = content && content.type === "text" ? content.text : "";

    const headerMd = [
      `**AX tree:** ${details.nodeCount} nodes · \`${details.url || "(no url)"}\``,
      titleLine ? `  ${titleLine}` : "",
      "",
      "```",
      treeText,
      "```",
      truncNote,
      "",
      `${keyHint("app.tools.expand", "to collapse")}`,
    ].filter((l) => l !== "").join("\n");

    const treeBlock = new Markdown(headerMd, 0, 0, getMarkdownTheme());

    if (!details.screenshotPath) return treeBlock;

    // Mirror screenshotTool's width-clamp wrapper for the inline image.
    try {
      const buf = readFileSync(details.screenshotPath);
      const b64 = buf.toString("base64");
      const imageTheme: ImageTheme = { fallbackColor: (s: string) => theme.fg("dim", s) };
      const image = new Image(b64, "image/jpeg", imageTheme, {
        maxWidthCells: 80,
        maxHeightCells: 24,
        filename: details.screenshotPath,
      });
      const safeImage = {
        invalidate: () => image.invalidate(),
        render: (width: number) =>
          image.render(width).map((line) => (visibleWidth(line) > width ? truncateToWidth(line, width) : line)),
      };
      const container = new Container();
      container.addChild(treeBlock);
      container.addChild(safeImage);
      return container;
    } catch {
      return treeBlock;
    }
  },
});
