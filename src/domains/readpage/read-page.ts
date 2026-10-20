import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { parseJson } from "../../schemas/parse";
import { type Result, err, ok } from "../../util/result";
import { applyTruncation } from "../../util/truncate";
import { type DetailsOf, defineBrowserTool, type ToolErr, type ToolOk } from "../../util/tool";
import type { BrowserClient } from "../../client";
import { cdpCallBrowser, evalJs } from "../cdp-call";
import { pageCallExpression } from "../page/inject";
import { capturePage } from "../page/read-page.page";
import type * as captured from "../page/read-page.page";
import {
  closeIsolatedTab,
  evalInIsolatedTab,
  isJsonText,
  type IsolatedTab,
  navigateIsolatedTab,
  openIsolatedTab,
  waitForIsolatedLoad,
} from "../isolated-tab";
import { ExpandableTextSchema, renderExpandableText } from "../render";
import { extractReadable, type PageCapture, type ReadablePage } from "./readability";

const LOAD_TIMEOUT_MS = 15_000;

const ReadPageArgs = Type.Object({
  url: Type.Optional(Type.String({ description: "URL to open in an isolated tab, read, then close." })),
  targetId: Type.Optional(
    Type.String({ description: "Read an already-open tab this session owns instead of opening a URL." }),
  ),
});

const ContentBlockSchema = Type.Object({
  kind: Type.Union([
    Type.Literal("paragraph"),
    Type.Literal("heading"),
    Type.Literal("listitem"),
    Type.Literal("blockquote"),
    Type.Literal("other"),
  ]),
  text: Type.String(),
  linkTextLength: Type.Number(),
  inBoilerplate: Type.Boolean(),
});

const PageCaptureSchema = Type.Object({
  url: Type.String(),
  title: Type.String(),
  blocks: Type.Array(ContentBlockSchema),
  bodyText: Type.String(),
});

const pageCaptureValidator = Compile(PageCaptureSchema);

const ReadPageDetailsSchema = Type.Object({
  title: Type.String(),
  url: Type.String(),
  wordCount: Type.Number(),
  render: ExpandableTextSchema,
  fullOutputPath: Type.Optional(Type.String()),
});

export type ReadPageDetails = DetailsOf<typeof ReadPageDetailsSchema>;

const BODY_TEXT_LIMIT = 20_000;

// The page function declares the capture shape it produces; this pins it to the shape the readability pass consumes,
// so the two cannot drift apart silently (the runtime validator above still guards the actual wire value).
export const asReadabilityCapture = (c: captured.PageCapture): PageCapture => c;

const buildPageCaptureExpr = (): string => pageCallExpression(capturePage, BODY_TEXT_LIMIT);

// Accepts the capture either as JSON text (isolated tab) or as the already-decoded value (owned tab).
export const toPageCapture = (raw: unknown): PageCapture | undefined => {
  if (typeof raw === "string") {
    const parsed = parseJson(raw, pageCaptureValidator);
    return parsed.success ? parsed.data : undefined;
  }
  return pageCaptureValidator.Check(raw) ? raw : undefined;
};

const captureToResult = async (raw: unknown): Promise<Result<ToolOk<ReadPageDetails>, ToolErr>> => {
  const parsed = toPageCapture(raw);
  if (parsed === undefined) return err({ kind: "internal", message: "page capture returned an unexpected shape" });
  const page: ReadablePage = extractReadable(parsed);
  const header = `# ${page.title}\n${page.url}\n(${page.wordCount} words)\n\n`;
  const truncated = await applyTruncation(header + page.text, "readpage");
  const summary = `${page.title} · ${page.wordCount} words`;
  return ok({
    text: truncated.text,
    details: {
      title: page.title,
      url: page.url,
      wordCount: page.wordCount,
      render: {
        summary,
        body: page.text,
        ...(truncated.fullOutputPath !== undefined ? { fullOutputPath: truncated.fullOutputPath } : {}),
      },
      ...(truncated.fullOutputPath !== undefined ? { fullOutputPath: truncated.fullOutputPath } : {}),
    },
  });
};

const readOpenedUrl = async (
  client: BrowserClient,
  url: string,
  signal: AbortSignal | undefined,
): Promise<Result<ToolOk<ReadPageDetails>, ToolErr>> => {
  const opened = await openIsolatedTab(client);
  if (!opened.success) return err(opened.error);
  const tab: IsolatedTab = opened.data;
  try {
    const navigated = await navigateIsolatedTab(client, tab, url);
    if (!navigated.success) return err(navigated.error);
    const loaded = await waitForIsolatedLoad(client, tab, LOAD_TIMEOUT_MS, signal);
    if (!loaded.success) return err(loaded.error);
    const captured = await evalInIsolatedTab(client, tab, buildPageCaptureExpr(), isJsonText);
    if (!captured.success) return err(captured.error);
    return await captureToResult(captured.data);
  } finally {
    await closeIsolatedTab(client, tab);
  }
};

const readOwnedTab = async (
  client: BrowserClient,
  targetId: string,
): Promise<Result<ToolOk<ReadPageDetails>, ToolErr>> => {
  if (!client.owns(targetId)) {
    return err({ kind: "invalid_state", message: `Tab ${targetId} is not owned by this session.` });
  }
  const attached = await cdpCallBrowser(client, "Target.attachToTarget", { targetId, flatten: true });
  if (!attached.success) return attached;
  const sessionId = attached.data.sessionId;
  try {
    const captured = await evalJs(client, buildPageCaptureExpr(), sessionId);
    if (!captured.success) return captured;
    return await captureToResult(captured.data);
  } finally {
    await cdpCallBrowser(client, "Target.detachFromTarget", { sessionId });
  }
};

export const readPageTool = defineBrowserTool({
  name: "browser_read_page",
  label: "Browser Read Page",
  description:
    "Read a page as clean article text — main content with nav/ads/boilerplate stripped. Pass a url (opened in an isolated tab, read, then closed) or a targetId of an owned tab. Reader-mode counterpart to browser_web_search.",
  promptSnippet: "Read a page's main content as clean text",
  promptGuidelines: [
    "Returns readable main-article text — use this over browser_snapshot/browser_execute_js when you want an article's content for reading or research.",
    "Boilerplate-heavy or structure-less pages fall back to bounded body text rather than erroring.",
  ],
  parameters: ReadPageArgs,
  details: ReadPageDetailsSchema,
  concurrency: "parallel",
  async handler(args, { client, signal }): Promise<Result<ToolOk<ReadPageDetails>, ToolErr>> {
    if (args.url !== undefined && args.url.length > 0) return readOpenedUrl(client, args.url, signal);
    if (args.targetId !== undefined && args.targetId.length > 0) return readOwnedTab(client, args.targetId);
    return err({ kind: "invalid_args", message: "provide either url or targetId" });
  },
  renderResult(result, expanded) {
    return renderExpandableText(result.details.render, expanded);
  },
});
