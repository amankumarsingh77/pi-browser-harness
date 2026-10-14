import { readFileSync } from "node:fs";
import { Type, type Static } from "typebox";
import { Container, Image, type ImageTheme, Markdown, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import { boxOf } from "./box";
import { cdpCall, cdpCallOnTarget, evalJs } from "./cdp-call";
import {
  buildTree,
  collectInteractiveTargets,
  countNodes,
  INTERACTIVE_ROLES,
  liveValue,
  type SlimNode,
  stripInternals,
  VALUE_ROLES,
} from "./ax-tree";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { applyTruncation } from "../util/truncate";
import { asBoolean, asNumber, asRecord, asString } from "../util/guards";
import { captureBase } from "./screenshot-capture";
import { safeJs } from "../util/js-template";

export const SnapshotArgs = Type.Object({
  includeScreenshot: Type.Optional(
    Type.Boolean({ default: false, description: "Also capture a JPEG screenshot of the current viewport." }),
  ),
  includeCursor: Type.Optional(
    Type.Boolean({ default: false, description: "Include the virtual cursor in an attached screenshot." }),
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

const summarize = (nodes: ReadonlyArray<SlimNode>): string => {
  const counts = new Map<string, number>();
  const walk = (ns: ReadonlyArray<SlimNode>): void => {
    for (const n of ns) {
      counts.set(n.role, (counts.get(n.role) ?? 0) + 1);
      walk(n.children);
    }
  };
  walk(nodes);
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
      if (n.ref) line += ` [${n.ref}]`;
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

type SnapshotDetails = {
  nodeCount: number;
  truncated: boolean;
  fullOutputPath?: string;
  screenshotPath?: string;
  url: string;
  title: string;
};

const readPageDetails = async (
  client: Parameters<typeof cdpCall>[0],
  sessionId?: string,
): Promise<Result<{ readonly url: string; readonly title: string }, ToolErr>> => {
  if (sessionId === undefined) {
    const page = await client.pageInfo();
    if (!page.success) return err({ kind: "cdp_error", message: page.error.message });
    return ok({
      url: "dialog" in page.data ? "" : page.data.url,
      title: "dialog" in page.data ? "" : page.data.title,
    });
  }
  const page = await evalJs(client, safeJs`({ url: location.href, title: document.title })`, sessionId);
  if (!page.success) return page;
  const record = asRecord(page.data);
  const url = record === undefined ? undefined : asString(record["url"]);
  const title = record === undefined ? undefined : asString(record["title"]);
  if (url === undefined || title === undefined) {
    return err({ kind: "invalid_state", message: "target page info returned an invalid value" });
  }
  return ok({ url, title });
};

const captureSnapshot = async (
  args: Static<typeof SnapshotArgs>,
  client: Parameters<typeof cdpCall>[0],
  sessionId?: string,
): Promise<Result<ToolOk, ToolErr>> => {
  const session = client.session();
  const axRes = sessionId === undefined
    ? await cdpCall(client, "Accessibility.getFullAXTree", {})
    : await cdpCallOnTarget(client, "Accessibility.getFullAXTree", {}, sessionId);
  if (!axRes.success) return axRes;
  const rawNodes = axRes.data.nodes;

  const page = await readPageDetails(client, sessionId);
  if (!page.success) return page;

  const slim = buildTree(rawNodes, {
    interestingOnly: args.interestingOnly ?? true,
    maxNodes: args.maxNodes ?? 1000,
  });

  const targets = collectInteractiveTargets(slim);

  const refMap = new Map<string, number>();
  targets.forEach(({ node, backendId }, i) => {
    const ref = `e${i + 1}`;
    node.ref = ref;
    refMap.set(ref, backendId);
  });

  if (targets.length > 0) {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), 1_500);
    await Promise.allSettled(
      targets.map(async ({ node, backendId }) => {
        if (ac.signal.aborted) return;
        const box = await boxOf(client, backendId, sessionId);
        if (!box.success) return;
        if (box.data.x < 0 || box.data.y < 0) return;
        node.box = box.data;
        if (ac.signal.aborted || !VALUE_ROLES.has(node.role)) return;
        const live = await liveValue(client, backendId, sessionId);
        if (live !== undefined) node.value = live;
      }),
    );
    clearTimeout(timer);
  }

  const refSig = new Map<string, string>();
  for (const { node } of targets) {
    if (node.ref === undefined) continue;
    refSig.set(node.ref, `${node.role}|${node.name ?? ""}|${node.value ?? ""}|${node.state ?? ""}`);
  }
  session.setRefMap(refMap, refSig);

  const stripped = stripInternals(slim);
  const text = (args.format ?? "outline") === "outline" ? renderOutline(slim) : JSON.stringify(stripped, null, 2);
  const trunc = await applyTruncation(text, "snapshot");

  let shotPath: string | undefined;
  if (args.includeScreenshot) {
    const shot = await captureBase(client, { format: "jpeg", quality: 80 }, sessionId);
    if (shot.success) shotPath = shot.data.path;
  }

  const details: SnapshotDetails = {
    nodeCount: countNodes(slim),
    truncated: trunc.wasTruncated,
    url: page.data.url,
    title: page.data.title,
  };
  if (trunc.fullOutputPath !== undefined) details.fullOutputPath = trunc.fullOutputPath;
  if (shotPath !== undefined) details.screenshotPath = shotPath;

  return ok({ text: trunc.text, details: { ...details, summary: summarize(slim) } });
};

export const snapshotTool = defineBrowserTool({
  name: "browser_snapshot",
  label: "Browser Snapshot",
  description:
    "DEFAULT tool for understanding what is on the page. Returns the structured accessibility tree (roles, names, states, hierarchy). Every interactive element gets a stable ref shown as [eN] plus click coordinates @(x,y). Pass the ref to browser_click/browser_fill/etc. — refs survive re-renders, coordinates don't. Use this BEFORE deciding whether you need a screenshot. Pair with browser_execute_js for surgical reads of specific element values.",
  promptSnippet: "Get accessibility-tree snapshot with stable element refs (default for page inspection)",
  promptGuidelines: [
    "DEFAULT — use this whenever you need to know what's on a page, what's clickable, or how the page is structured.",
    "Refs come for free: every interactive element shows '[eN]' in the outline. Pass eN as `ref` to browser_click/browser_fill/browser_select_option/browser_focus/browser_upload_file — refs survive re-renders, so prefer them over the '@(x,y)' coordinates (a fallback).",
    "DO NOT call browser_screenshot just to understand the page. This tool already gives you structure, labels, states, refs, and click targets.",
    "Re-run after a navigation or a major re-render to get fresh refs; a 'ref is stale' error from an interaction tool means you need a new snapshot.",
    "Pass includeScreenshot:true ONLY if you also need to verify visual rendering (rare).",
    "format:'json' returns the raw slim structure (with `ref` and `box` per node) for programmatic use; default 'outline' is human/LLM-readable.",
  ],
  parameters: SnapshotArgs,
  concurrency: "parallel",

  async handler(args, { client, cursor }): Promise<Result<ToolOk, ToolErr>> {
    if (args.includeCursor === true && args.includeScreenshot !== true) {
      return err({ kind: "invalid_state", message: "includeCursor:true requires includeScreenshot:true" });
    }
    if (!args.includeScreenshot) return captureSnapshot(args, client);
    const releaseMutation = await client.mutationMutex().acquire();
    try {
      const visible = await cursor.withCaptureVisibility(args.includeCursor ?? false, async (target) =>
        captureSnapshot(args, client, target.sessionId));
      if (!visible.success) return visible;
      return ok({
        ...visible.data,
        details: {
          ...(visible.data.details ?? {}),
          ...(visible.visibility.cursorSuppression === undefined
            ? {}
            : { cursorSuppression: visible.visibility.cursorSuppression }),
          ...(visible.visibility.cursorReason === undefined
            ? {}
            : { cursorReason: visible.visibility.cursorReason }),
        },
      });
    } finally {
      releaseMutation();
    }
  },

  renderResult(result, expanded, theme) {
    const raw = asRecord(result.details);
    if (raw === undefined) return new Text(theme.fg("error", "snapshot: no details"), 0, 0);
    const details = {
      nodeCount: asNumber(raw["nodeCount"]),
      truncated: asBoolean(raw["truncated"]),
      fullOutputPath: asString(raw["fullOutputPath"]),
      screenshotPath: asString(raw["screenshotPath"]),
      url: asString(raw["url"]),
      title: asString(raw["title"]),
      summary: asString(raw["summary"]),
    };

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
