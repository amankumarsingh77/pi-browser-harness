import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { parseJson } from "../../schemas/parse";
import { type Result, err, ok } from "../../util/result";
import { applyTruncation } from "../../util/truncate";
import { type DetailsOf, defineBrowserTool, type ToolErr, type ToolOk } from "../../util/tool";
import type { BrowserClient } from "../../client";
import {
  closeIsolatedTab,
  evalInIsolatedTab,
  type IsolatedTab,
  isJsonText,
  navigateIsolatedTab,
  openIsolatedTab,
  waitForIsolatedLoad,
} from "../isolated-tab";
import { pageCallExpression } from "../page/inject";
import { pollUntil } from "../poll";
import { safeJs } from "../../util/js-template";
import { extractSerp } from "../page/serp.page";
import type * as extracted from "../page/serp.page";
import { ExpandableTextSchema, renderExpandableText } from "../render";
import { deadlineSignal, runLimited } from "../concurrency";
import { defaultEngines, type EngineRegistry } from "./engines";
import {
  classifySerpWith,
  parseSerp,
  type ResolvedTargets,
  type SearchEngine,
  type SearchResult,
  type SerpExtraction,
  type SerpSelectors,
} from "./serp";
import { fetchRedirectTarget, type RedirectResolver } from "./redirect-resolver";

const LOAD_TIMEOUT_MS = 15_000;
const RESOLVE_BUDGET_MS = 5_000;
const RESOLVE_CONCURRENCY = 5;
const RENDER_WAIT_MS = 4_000;

export type WebSearchDeps = {
  // The mounted engines; mount order is the fallback ladder.
  readonly engines: EngineRegistry;
  readonly resolveRedirect: RedirectResolver;
  readonly resolveBudgetMs?: number;
};

// Resolves every server-side redirect anchor (Google /goto) in parallel under one time budget; a slot that fails or
// runs out of time is simply absent from the map, and the engine falls back to that anchor's cite.
const resolveRedirectTargets = async (
  engine: SearchEngine,
  anchors: ReadonlyArray<SerpExtraction["anchors"][number]>,
  deps: WebSearchDeps,
  signal: AbortSignal | undefined,
): Promise<ResolvedTargets> => {
  const needsResolve = engine.needsRedirectResolve;
  if (needsResolve === undefined) return new Map();
  const hrefs = anchors.map((a) => a.href).filter(needsResolve);
  if (hrefs.length === 0) return new Map();
  const deadline = deadlineSignal(deps.resolveBudgetMs ?? RESOLVE_BUDGET_MS, signal);
  const targets = await runLimited(hrefs, { limit: RESOLVE_CONCURRENCY, signal: deadline.signal }, (href, s) =>
    deps.resolveRedirect(href, s),
  );
  deadline.clear();
  const resolved = new Map<string, string>();
  hrefs.forEach((href, i) => {
    const target = targets[i];
    if (target !== undefined) resolved.set(href, target);
  });
  return resolved;
};

const PAGE_TEXT_LIMIT = 4000;

// The page function declares the extraction shape it produces; this pins it to the shape the SERP parser consumes,
// so the two cannot drift apart silently (the runtime validator below still guards the actual wire value).
type Pinned<T extends SerpExtraction> = T;
export type ExtractionFromPage = Pinned<extracted.SerpExtraction>;
type PinnedSelectors<T extends extracted.SerpSelectors> = T;
export type SelectorsForPage = PinnedSelectors<SerpSelectors>;

const extractionExpression = (engine: SearchEngine): string =>
  pageCallExpression(extractSerp, engine.selectors, PAGE_TEXT_LIMIT);

const SerpExtractionSchema = Type.Object({
  anchors: Type.Array(
    Type.Object({
      href: Type.String(),
      heading: Type.String(),
      snippet: Type.String(),
      cite: Type.Optional(Type.String()),
    }),
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

const AttemptSchema = Type.Object({
  engine: Type.String(),
  kind: Type.String(),
  reason: Type.Optional(Type.String()),
  message: Type.String(),
});

const WebSearchDetailsSchema = Type.Object({
  results: Type.Array(SearchResultSchema),
  engine: Type.String(),
  query: Type.String(),
  // Engines tried and failed before `engine` answered; absent when the first engine answered.
  fallbacks: Type.Optional(Type.Array(AttemptSchema)),
  render: ExpandableTextSchema,
  fullOutputPath: Type.Optional(Type.String()),
});

export type WebSearchDetails = DetailsOf<typeof WebSearchDetailsSchema>;
type Attempt = DetailsOf<typeof AttemptSchema>;

const formatResults = (query: string, results: ReadonlyArray<SearchResult>): string => {
  const lines = results.map((r) => `${r.rank}. ${r.title}\n   ${r.url}\n   ${r.snippet}`);
  return `${results.length} result(s) for "${query}":\n\n${lines.join("\n\n")}`;
};

// One engine, one SERP, in the already-open isolated tab.
const searchEngine = async (
  engine: SearchEngine,
  query: string,
  limit: number,
  ctx: {
    readonly client: BrowserClient;
    readonly tab: IsolatedTab;
    readonly signal: AbortSignal | undefined;
    readonly expression: string;
  },
  deps: WebSearchDeps,
): Promise<Result<ReadonlyArray<SearchResult>, ToolErr>> => {
  const { client, tab, signal, expression } = ctx;
  const serpUrl = engine.buildUrl(query, limit);

  const navigated = await navigateIsolatedTab(client, tab, serpUrl);
  if (!navigated.success) return err(navigated.error);

  const loaded = await waitForIsolatedLoad(client, tab, LOAD_TIMEOUT_MS, signal);
  if (!loaded.success) return err(loaded.error);

  if (engine.readySelector !== undefined) {
    // A miss is not a failure: a bot wall or an empty SERP never renders results, and extraction classifies it.
    await pollUntil(client, safeJs`document.querySelector(${engine.readySelector}) !== null`, {
      timeoutMs: RENDER_WAIT_MS,
      signal,
      sessionId: tab.sessionId,
      what: `${engine.name} results`,
    });
    if (signal?.aborted === true) return err({ kind: "timeout", message: `Aborted while waiting for ${engine.name} results` });
  }

  const evaluated = await evalInIsolatedTab(client, tab, expression, isJsonText);
  if (!evaluated.success) return err(evaluated.error);

  const parsedJson = parseSerpExtraction(evaluated.data);
  if (!parsedJson.success) {
    return err({ kind: "internal", message: `SERP extraction returned an unexpected shape: ${parsedJson.error}` });
  }
  const extraction: SerpExtraction = parsedJson.data;

  const resolved = await resolveRedirectTargets(engine, extraction.anchors, deps, signal);
  const results = parseSerp(engine, extraction.anchors, limit, resolved);
  const anchorCount = extraction.anchors.length;
  const verdict = classifySerpWith(engine.captchaMarkers, extraction.pageText, results.length, anchorCount);
  if (verdict === "captcha") {
    return err({
      kind: "invalid_state",
      message: `${engine.name} served a CAPTCHA / bot wall`,
      details: { reason: verdict, serpUrl },
    });
  }
  if (verdict === "extraction_mismatch") {
    return err({
      kind: "invalid_state",
      message: `found ${anchorCount} result anchor(s) but none parsed to an external url (${engine.name} markup may have changed)`,
      details: { reason: verdict, anchorCount, serpUrl },
    });
  }
  if (verdict === "no_results") {
    return err({ kind: "invalid_state", message: "no results found", details: { reason: verdict, serpUrl } });
  }
  return ok(results);
};

const withEngine = (engine: string, error: ToolErr): ToolErr => ({
  ...error,
  details: { ...error.details, engine },
});

const toAttempt = (engine: string, error: ToolErr): Attempt => {
  const reason = error.details?.["reason"];
  return {
    engine,
    kind: error.kind,
    ...(typeof reason === "string" ? { reason } : {}),
    message: error.message,
  };
};

// A dead browser or a cancelled call fails every engine the same way, so the ladder stops instead of trying the next.
const stopsLadder = (error: ToolErr, signal: AbortSignal | undefined): boolean =>
  signal?.aborted === true || error.kind === "not_connected";

const exhausted = (attempts: ReadonlyArray<Attempt>): ToolErr => {
  const allEmpty = attempts.every((a) => a.reason === "no_results");
  const summary = attempts.map((a) => `${a.engine}: ${a.message}`).join("; ");
  return {
    kind: "invalid_state",
    message: allEmpty ? `no results found on any engine (${summary})` : `every search engine failed (${summary})`,
    details: { reason: allEmpty ? "no_results" : "all_engines_failed", attempts },
  };
};

// A named engine is tried alone; no name means the whole mounted ladder.
const pickLadder = (
  engines: EngineRegistry,
  name: string | undefined,
): Result<ReadonlyArray<SearchEngine>, ToolErr> => {
  if (name === undefined) return ok(engines.ladder());
  const named = engines.get(name);
  if (named !== undefined) return ok([named]);
  return err({
    kind: "invalid_args",
    message: `unknown search engine "${name}"; mounted engines: ${engines.ids().join(", ")}`,
    details: { engine: name, engines: engines.ids() },
  });
};

const webSearchArgs = (engines: EngineRegistry) =>
  Type.Object({
    query: Type.String({ description: "The search query." }),
    limit: Type.Optional(
      Type.Integer({ default: 10, minimum: 1, maximum: 30, description: "Max results to return. Default: 10." }),
    ),
    engine: Type.Optional(
      Type.String({
        enum: [...engines.ids()],
        description: `Search only this engine (${engines.ids().join(", ")}), with no fallback. Omit to walk the fallback ladder ${engines.ids().join(" → ")} until one returns results.`,
      }),
    ),
  });

export const createWebSearchTool = (deps: WebSearchDeps) => {
  const { engines } = deps;
  const ids = engines.ids();
  if (ids.length === 0) throw new Error("browser_web_search needs at least one mounted search engine");
  const ladderText = ids.join(" → ");
  // Built once per engine: stringifying the page function per call was the only cost of the thunk.
  const expressions = new Map(engines.ladder().map((e) => [e.id, extractionExpression(e)] as const));

  return defineBrowserTool({
    name: "browser_web_search",
    label: "Browser Web Search",
    description:
      `Search the web and return ranked results (title, url, snippet, rank). Scrapes a search engine results page in the real Chrome — no API key. Engines: ${ids.join(", ")}. With no engine given it walks the fallback ladder ${ladderText} until one returns results. Returns links only; use browser_read_page to read a result's content.`,
    promptSnippet: "Search the web for a query",
    promptGuidelines: [
      `Omit engine to get the fallback ladder (${ladderText}); details.engine says which engine answered and details.fallbacks lists the engines that failed first.`,
      "Pass engine only when one engine is specifically needed; a named engine is tried alone, with no fallback.",
      "On a CAPTCHA / bot wall the call fails with kind:'invalid_state' and details.reason:'captcha' (plus serpUrl and engine) — surface it to the user; do not retry in a tight loop.",
      "On zero results it fails with details.reason:'no_results' — rephrase the query and try again.",
      "If results were on the page but none could be parsed it fails with details.reason:'extraction_mismatch' (plus anchorCount) — the engine's markup changed; report it rather than retrying.",
      "When every engine on the ladder fails it is details.reason:'all_engines_failed' with details.attempts naming each engine's failure.",
      "Runs in its own isolated tab and never disturbs the user's current tab.",
    ],
    parameters: webSearchArgs(engines),
    details: WebSearchDetailsSchema,
    concurrency: "serialized",
    async handler(args, { client, signal }): Promise<Result<ToolOk<WebSearchDetails>, ToolErr>> {
      const limit = args.limit ?? 10;
      const ladder = pickLadder(engines, args.engine);
      if (!ladder.success) return err(ladder.error);

      const opened = await openIsolatedTab(client);
      if (!opened.success) return err(opened.error);
      const tab = opened.data;

      try {
        const attempts: Attempt[] = [];
        for (const engine of ladder.data) {
          const id = engine.id;
          const expression = expressions.get(id) ?? extractionExpression(engine);
          const searched = await searchEngine(engine, args.query, limit, { client, tab, signal, expression }, deps);
          if (!searched.success) {
            // A single named engine reports its own failure exactly, as if there were no ladder.
            if (ladder.data.length === 1 || stopsLadder(searched.error, signal)) return err(withEngine(id, searched.error));
            attempts.push(toAttempt(id, searched.error));
            continue;
          }
          const results = searched.data;
          const body = formatResults(args.query, results);
          const truncated = await applyTruncation(body, "search");
          const via = attempts.length > 0 ? ` (after ${attempts.map((a) => a.engine).join(", ")} failed)` : "";
          return ok({
            text: truncated.text,
            details: {
              results,
              engine: id,
              query: args.query,
              ...(attempts.length > 0 ? { fallbacks: attempts } : {}),
              render: {
                summary: `${results.length} result(s) · ${id}${via} · "${args.query}"`,
                body,
                ...(truncated.fullOutputPath !== undefined ? { fullOutputPath: truncated.fullOutputPath } : {}),
              },
              ...(truncated.fullOutputPath !== undefined ? { fullOutputPath: truncated.fullOutputPath } : {}),
            },
          });
        }
        return err(exhausted(attempts));
      } finally {
        await closeIsolatedTab(client, tab);
      }
    },
    renderResult(result, expanded) {
      return renderExpandableText(result.details.render, expanded);
    },
  });
};

export const webSearchTool = createWebSearchTool({ engines: defaultEngines(), resolveRedirect: fetchRedirectTarget });
