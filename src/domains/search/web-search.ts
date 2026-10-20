import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { parseJson } from "../../schemas/parse";
import { type Result, err, ok } from "../../util/result";
import { applyTruncation } from "../../util/truncate";
import { type DetailsOf, defineBrowserTool, type ToolErr, type ToolOk } from "../../util/tool";
import {
  closeIsolatedTab,
  evalInIsolatedTab,
  isJsonText,
  navigateIsolatedTab,
  openIsolatedTab,
  waitForIsolatedLoad,
} from "../isolated-tab";
import { pageCallExpression } from "../page/inject";
import { extractSerp } from "../page/serp.page";
import type * as extracted from "../page/serp.page";
import { ExpandableTextSchema, renderExpandableText } from "../render";
import { classifySerp, parseGoogleSerp, type SearchResult, type SerpExtraction } from "./google-serp";

const LOAD_TIMEOUT_MS = 15_000;

const WebSearchArgs = Type.Object({
  query: Type.String({ description: "The search query." }),
  limit: Type.Optional(
    Type.Integer({ default: 10, minimum: 1, maximum: 30, description: "Max results to return. Default: 10." }),
  ),
});

const PAGE_TEXT_LIMIT = 4000;

// The page function declares the extraction shape it produces; this pins it to the shape the SERP parser consumes,
// so the two cannot drift apart silently (the runtime validator below still guards the actual wire value).
type Pinned<T extends SerpExtraction> = T;
export type ExtractionFromPage = Pinned<extracted.SerpExtraction>;

// Built once: stringifying the page function per call was the only cost of the thunk.
const SERP_EXTRACTION_EXPR = pageCallExpression(extractSerp, PAGE_TEXT_LIMIT);

const buildSerpUrl = (query: string, limit: number): string =>
  `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${limit}&hl=en`;

const SerpExtractionSchema = Type.Object({
  anchors: Type.Array(
    Type.Object({ href: Type.String(), heading: Type.String(), snippet: Type.String() }),
  ),
  pageText: Type.String(),
});

const serpExtractionValidator = Compile(SerpExtractionSchema);

export const parseSerpExtraction = (raw: string): Result<SerpExtraction, string> =>
  parseJson(raw, serpExtractionValidator);

const SearchResultSchema = Type.Object({
  title: Type.String(),
  url: Type.String(),
  snippet: Type.String(),
  rank: Type.Number(),
});

const WebSearchDetailsSchema = Type.Object({
  results: Type.Array(SearchResultSchema),
  engine: Type.Literal("google"),
  query: Type.String(),
  render: ExpandableTextSchema,
  fullOutputPath: Type.Optional(Type.String()),
});

export type WebSearchDetails = DetailsOf<typeof WebSearchDetailsSchema>;

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
    "On a CAPTCHA / bot wall the call fails with kind:'invalid_state' and details.reason:'captcha' (plus serpUrl) — surface it to the user; do not retry in a tight loop.",
    "On zero results it fails with details.reason:'no_results' — rephrase the query and try again.",
    "Runs in its own isolated tab and never disturbs the user's current tab.",
  ],
  parameters: WebSearchArgs,
  details: WebSearchDetailsSchema,
  concurrency: "serialized",
  async handler(args, { client, signal }): Promise<Result<ToolOk<WebSearchDetails>, ToolErr>> {
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

      const extracted = await evalInIsolatedTab(client, tab, SERP_EXTRACTION_EXPR, isJsonText);
      if (!extracted.success) return err(extracted.error);

      const parsedJson = parseSerpExtraction(extracted.data);
      if (!parsedJson.success) {
        return err({ kind: "internal", message: `SERP extraction returned an unexpected shape: ${parsedJson.error}` });
      }
      const extraction: SerpExtraction = parsedJson.data;

      const results = parseGoogleSerp(extraction.anchors, limit);
      const verdict = classifySerp(extraction.pageText, results.length);
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
  renderResult(result, expanded) {
    return renderExpandableText(result.details.render, expanded);
  },
});
