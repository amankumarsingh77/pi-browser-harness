import { Type } from "typebox";
import { type Result, err, ok } from "../../util/result";
import { applyTruncation } from "../../util/truncate";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../../util/tool";
import {
  closeIsolatedTab,
  evalInIsolatedTab,
  navigateIsolatedTab,
  openIsolatedTab,
  waitForIsolatedLoad,
} from "../isolated-tab";
import { renderExpandableText } from "../render";
import { buildSerpExtractionExpr } from "./extract";
import { classifySerp, parseGoogleSerp, type SearchResult, type SerpExtraction } from "./google-serp";

const LOAD_TIMEOUT_MS = 15_000;

const WebSearchArgs = Type.Object({
  query: Type.String({ description: "The search query." }),
  limit: Type.Optional(
    Type.Integer({ default: 10, minimum: 1, maximum: 30, description: "Max results to return. Default: 10." }),
  ),
});

const buildSerpUrl = (query: string, limit: number): string =>
  `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${limit}&hl=en`;

const isSerpExtraction = (value: unknown): value is SerpExtraction => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return Array.isArray(v["anchors"]) && typeof v["pageText"] === "string";
};

const formatResults = (query: string, results: ReadonlyArray<SearchResult>): string => {
  const lines = results.map((r) => `${r.rank}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
  return `${results.length} result(s) for "${query}":\n\n${lines.join("\n\n")}`;
};

export const webSearchTool = defineBrowserTool({
  name: "browser_web_search",
  label: "Browser Web Search",
  description:
    "Search the web and return ranked results (title, url, snippet, rank). Scrapes a Google results page in the real Chrome — no API key. Returns links only; use browser_read_page to read a result's content.",
  promptSnippet: "Search the web for a query",
  promptGuidelines: [
    "Returns ranked {title, url, snippet, rank} — links only, no page content. Follow up with browser_read_page.",
    "On a CAPTCHA / bot wall the call fails with kind:'invalid_state' and details.reason:'captcha' (plus serpUrl) — surface it to the user; do not retry in a tight loop.",
    "On zero results it fails with details.reason:'no_results' — rephrase the query and try again.",
    "Runs in its own isolated tab and never disturbs the user's current tab.",
  ],
  parameters: WebSearchArgs,
  async handler(args, { client, signal }): Promise<Result<ToolOk, ToolErr>> {
    const limit = args.limit ?? 10;
    const serpUrl = buildSerpUrl(args.query, limit);

    const opened = await openIsolatedTab(client);
    if (!opened.success) return err(opened.error);
    const tab = opened.data;

    try {
      const navigated = await navigateIsolatedTab(client, tab, serpUrl);
      if (!navigated.success) return err(navigated.error);

      const loaded = await waitForIsolatedLoad(client, tab, LOAD_TIMEOUT_MS, signal);
      if (!loaded.success) return err(loaded.error);

      const extracted = await evalInIsolatedTab(client, tab, buildSerpExtractionExpr());
      if (!extracted.success) return err(extracted.error);

      const parsedJson = typeof extracted.data === "string" ? safeParse(extracted.data) : extracted.data;
      if (!isSerpExtraction(parsedJson)) {
        return err({ kind: "internal", message: "SERP extraction returned an unexpected shape" });
      }

      const results = parseGoogleSerp(parsedJson.anchors, limit);
      const verdict = classifySerp(parsedJson.pageText, results.length);
      if (verdict !== "ok") {
        return err({
          kind: "invalid_state",
          message: verdict === "captcha" ? "Google served a CAPTCHA / bot wall" : "no results found",
          details: { reason: verdict, serpUrl },
        });
      }

      const body = formatResults(args.query, results);
      const truncated = await applyTruncation(body, "search");
      return ok({
        text: truncated.text,
        details: {
          results,
          engine: "google",
          query: args.query,
          render: {
            summary: `${results.length} result(s) · google · "${args.query}"`,
            body,
            ...(truncated.fullOutputPath !== undefined ? { fullOutputPath: truncated.fullOutputPath } : {}),
          },
          ...(truncated.fullOutputPath !== undefined ? { fullOutputPath: truncated.fullOutputPath } : {}),
        },
      });
    } finally {
      await closeIsolatedTab(client, tab);
    }
  },
  renderResult(result, expanded, theme) {
    return renderExpandableText("web_search", result, expanded, theme);
  },
});

const safeParse = (text: string): unknown => {
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return undefined;
  }
};
