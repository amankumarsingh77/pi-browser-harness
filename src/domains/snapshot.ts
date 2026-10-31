import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Container, Image, type ImageTheme, Markdown, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "../client";
import { boxOf } from "./box";
import { cdpCall, fromClient } from "./cdp-call";
import { deadlineSignal, runLimited } from "./concurrency";
import { writeFileResult } from "./io";
import { type RefSignature, signatureOf } from "./ref-signature";
import {
  buildTree,
  collectInteractiveTargets,
  countNodes,
  firstNodes,
  INTERACTIVE_ROLES,
  keepOnly,
  liveValue,
  type SlimNode,
  stripInternals,
  VALUE_ROLES,
} from "./ax-tree";
import { type Result, ok } from "../util/result";
import { type DetailsOf, defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
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

const SnapshotDetailsSchema = Type.Object({
  nodeCount: Type.Number(),
  truncated: Type.Boolean(),
  fullOutputPath: Type.Optional(Type.String()),
  screenshotPath: Type.Optional(Type.String()),
  url: Type.String(),
  title: Type.String(),
  summary: Type.String(),
});

export type SnapshotDetails = DetailsOf<typeof SnapshotDetailsSchema>;

const BOX_BUDGET_MS = 1_500;
const BOX_CONCURRENCY = 8;

// Best-effort: a capture or write failure just drops the screenshot from the result.
const captureJpeg = async (client: BrowserClient): Promise<string | undefined> => {
  const shot = await cdpCall(client, "Page.captureScreenshot", { format: "jpeg", quality: 80 });
  if (!shot.success) return undefined;
  const path = screenshotPath(client.namespace, "jpeg");
  const written = await writeFileResult(path, Buffer.from(shot.data.data, "base64"));
  return written.success ? path : undefined;
};

export const snapshotTool = defineBrowserTool({
  name: "browser_snapshot",
  label: "Browser Snapshot",
  description:
    "DEFAULT tool for understanding what is on the page. Returns the structured accessibility tree (roles, names, states, hierarchy). Every interactive element gets a stable ref shown as [eN] plus click coordinates @(x,y). Pass the ref to browser_click/browser_fill/etc. — refs survive re-renders, coordinates don't. Use this BEFORE deciding whether you need a screenshot. Pair with browser_execute_js for surgical reads of specific element values.",
  promptSnippet: "Get accessibility-tree snapshot with stable element refs (default for page inspection)",
  promptGuidelines: [
    "Re-run browser_snapshot after a navigation or a major re-render to get fresh refs.",
    "Pass includeScreenshot:true ONLY if you also need to verify visual rendering (rare).",
    "format:'json' returns the raw slim structure (with `ref` and `box` per node) for programmatic use; default 'outline' is human/LLM-readable.",
  ],
  parameters: SnapshotArgs,
  details: SnapshotDetailsSchema,
  concurrency: "parallel",

  async handler(args, { client, signal }): Promise<Result<ToolOk<SnapshotDetails>, ToolErr>> {
    const session = client.session();

    const axRes = await cdpCall(client, "Accessibility.getFullAXTree", {});
    if (!axRes.success) return axRes;
    const rawNodes = axRes.data.nodes;

    const piRes = fromClient(await client.pageInfo(), "pageInfo");
    if (!piRes.success) return piRes;
    const pageUrl = piRes.data.kind === "dialog" ? "" : piRes.data.url;
    const pageTitle = piRes.data.kind === "dialog" ? "" : piRes.data.title;

    // Every element gets a ref, so a tool or a recipe can reach one the shown outline cut off; maxNodes limits
    // only what is shown.
    const full = buildTree(rawNodes, { interestingOnly: args.interestingOnly ?? true, maxNodes: Number.POSITIVE_INFINITY });
    const shown = firstNodes(full, args.maxNodes ?? 1000);

    const targets = collectInteractiveTargets(full);

    const refMap = new Map<string, number>();
    targets.forEach(({ node, backendId }, i) => {
      const ref = `e${i + 1}`;
      node.ref = ref;
      refMap.set(ref, backendId);
    });

    if (targets.length > 0) {
      // Geometry and live values are best-effort decoration: whatever lands inside the budget is kept, the rest is omitted.
      const deadline = deadlineSignal(BOX_BUDGET_MS, signal);
      const visible = targets.filter(({ node }) => shown.has(node));
      await runLimited(visible, { limit: BOX_CONCURRENCY, signal: deadline.signal }, async ({ node, backendId }, sig) => {
        const box = await boxOf(client, backendId);
        if (!box.success || sig.aborted) return;
        if (box.data.x < 0 || box.data.y < 0) return;
        node.box = box.data;
        if (!VALUE_ROLES.has(node.role)) return;
        const live = await liveValue(client, backendId);
        if (live !== undefined) node.value = live;
      });
      deadline.clear();
    }

    const refSig = new Map<string, RefSignature>();
    for (const { node } of targets) {
      if (node.ref === undefined) continue;
      refSig.set(node.ref, signatureOf(node));
    }
    session.setRefMap(refMap, refSig);

    const slim = keepOnly(full, shown);

    const text = (args.format ?? "outline") === "outline" ? renderOutline(slim) : JSON.stringify(stripInternals(slim), null, 2);
    const trunc = await applyTruncation(text, "snapshot");

    const shotPath = args.includeScreenshot ? await captureJpeg(client) : undefined;

    const details: SnapshotDetails = {
      nodeCount: countNodes(slim),
      truncated: trunc.wasTruncated,
      url: pageUrl,
      title: pageTitle,
      summary: summarize(slim),
      ...(trunc.fullOutputPath !== undefined ? { fullOutputPath: trunc.fullOutputPath } : {}),
      ...(shotPath !== undefined ? { screenshotPath: shotPath } : {}),
    };

    return ok({ text: trunc.text, details });
  },

  renderResult(result, expanded, theme) {
    const details = result.details;
    const titleLine = details.title !== "" ? ` "${details.title}"` : "";
    const urlLabel = details.url !== "" ? details.url : "(no url)";
    const screenshotNote = details.screenshotPath !== undefined ? "screenshot attached" : "screenshot omitted";
    const truncNote = details.truncated && details.fullOutputPath !== undefined ? `\n\nFull tree at \`${details.fullOutputPath}\`` : "";

    if (!expanded) {
      const md = [
        `**AX tree:** ${details.nodeCount} nodes · \`${urlLabel}\``,
        titleLine !== "" ? `  ${titleLine}` : "",
        details.summary !== "" ? `  • ${details.summary}` : "",
        `  ${keyHint("app.tools.expand", "to expand")} · ${screenshotNote}`,
      ].filter((l) => l !== "").join("\n");
      return new Markdown(md, 0, 0, getMarkdownTheme());
    }

    const content = result.content[0];
    const treeText = content?.type === "text" ? content.text : "";

    const headerMd = [
      `**AX tree:** ${details.nodeCount} nodes · \`${urlLabel}\``,
      titleLine !== "" ? `  ${titleLine}` : "",
      "",
      "```",
      treeText,
      "```",
      truncNote,
      "",
      keyHint("app.tools.expand", "to collapse"),
    ].filter((l) => l !== "").join("\n");

    const treeBlock = new Markdown(headerMd, 0, 0, getMarkdownTheme());

    if (details.screenshotPath === undefined) return treeBlock;

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
        invalidate: () => { image.invalidate(); },
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
