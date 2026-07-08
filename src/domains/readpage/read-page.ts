import { Type } from "typebox";
import { type Result, err, ok } from "../../util/result";
import { applyTruncation } from "../../util/truncate";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../../util/tool";
import {
  closeIsolatedTab,
  evalInIsolatedTab,
  type IsolatedTab,
  navigateIsolatedTab,
  openIsolatedTab,
  waitForIsolatedLoad,
} from "../isolated-tab";
import { renderExpandableText } from "../render";
import { buildPageCaptureExpr } from "./capture";
import { extractReadable, type PageCapture, type ReadablePage } from "./readability";

const LOAD_TIMEOUT_MS = 15_000;

const ReadPageArgs = Type.Object({
  url: Type.Optional(Type.String({ description: "URL to open in an isolated tab, read, then close." })),
  targetId: Type.Optional(
    Type.String({ description: "Read an already-open tab this session owns instead of opening a URL." }),
  ),
});

const isPageCapture = (value: unknown): value is PageCapture => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["url"] === "string" && typeof v["title"] === "string" && Array.isArray(v["blocks"]) && typeof v["bodyText"] === "string";
};

const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};

const captureToResult = async (raw: unknown): Promise<Result<ToolOk, ToolErr>> => {
  const parsed = typeof raw === "string" ? safeParse(raw) : raw;
  if (!isPageCapture(parsed)) return err({ kind: "internal", message: "page capture returned an unexpected shape" });
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
  client: Parameters<typeof openIsolatedTab>[0],
  url: string,
  signal: AbortSignal | undefined,
): Promise<Result<ToolOk, ToolErr>> => {
  const opened = await openIsolatedTab(client);
  if (!opened.success) return err(opened.error);
  const tab: IsolatedTab = opened.data;
  try {
    const navigated = await navigateIsolatedTab(client, tab, url);
    if (!navigated.success) return err(navigated.error);
    const loaded = await waitForIsolatedLoad(client, tab, LOAD_TIMEOUT_MS, signal);
    if (!loaded.success) return err(loaded.error);
    const captured = await evalInIsolatedTab(client, tab, buildPageCaptureExpr());
    if (!captured.success) return err(captured.error);
    return captureToResult(captured.data);
  } finally {
    await closeIsolatedTab(client, tab);
  }
};

const readOwnedTab = async (
  client: Parameters<typeof openIsolatedTab>[0],
  targetId: string,
): Promise<Result<ToolOk, ToolErr>> => {
  if (!client.owns(targetId)) {
    return err({ kind: "invalid_state", message: `Tab ${targetId} is not owned by this session.` });
  }
  const attached = await client.session().callBrowser("Target.attachToTarget", { targetId, flatten: true });
  if (!attached.success) return err({ kind: "cdp_error", message: attached.error.message });
  const sessionId = (attached.data as { sessionId: string }).sessionId;
  const captured = await client.evaluateJs(buildPageCaptureExpr(), sessionId);
  if (!captured.success) return err({ kind: "cdp_error", message: captured.error.message });
  return captureToResult(captured.data);
};

export const readPageTool = defineBrowserTool({
  name: "browser_read_page",
  label: "Browser Read Page",
  description:
    "Read a page as clean article text — main content with nav/ads/boilerplate stripped. Pass a url (opened in an isolated tab, read, then closed) or a targetId of an owned tab. Reader-mode counterpart to browser_web_search.",
  promptSnippet: "Read a page's main content as clean text",
  promptGuidelines: [
    "Pass url to read an arbitrary page (opened + closed in its own tab, never disturbing your current tab), or targetId to read an already-open owned tab.",
    "Returns readable main-article text — use this over browser_snapshot/browser_execute_js when you want an article's content for reading or research.",
    "Boilerplate-heavy or structure-less pages fall back to bounded body text rather than erroring.",
  ],
  parameters: ReadPageArgs,
  async handler(args, { client, signal }): Promise<Result<ToolOk, ToolErr>> {
    if (args.url !== undefined && args.url.length > 0) return readOpenedUrl(client, args.url, signal);
    if (args.targetId !== undefined && args.targetId.length > 0) return readOwnedTab(client, args.targetId);
    return err({ kind: "invalid_state", message: "provide either url or targetId" });
  },
  renderResult(result, expanded, theme) {
    return renderExpandableText("read_page", result, expanded, theme);
  },
});
