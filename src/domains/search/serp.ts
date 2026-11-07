// Engine-neutral SERP vocabulary and parsing. Each engine (engines/*.ts) supplies how to find result anchors on its
// page and how to turn an anchor into its target url; ranking, dedupe and verdicts are shared here.

export type SerpAnchor = {
  readonly href: string;
  readonly heading: string;
  readonly snippet: string;
  // Visible breadcrumb url ("https://host › path › seg"); the fallback when the href is an opaque redirect.
  readonly cite?: string;
};

export type SerpExtraction = {
  readonly anchors: ReadonlyArray<SerpAnchor>;
  readonly pageText: string;
};

export type SearchResult = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly rank: number;
};

export type SerpVerdict = "ok" | "captcha" | "no_results" | "extraction_mismatch";

// Redirect hrefs resolved server-side (Google /goto), keyed by href.
export type ResolvedTargets = ReadonlyMap<string, string>;

// Selectors handed to the page-side extractor. Every result is found from its heading: the title element is either
// the result link itself or sits inside / around it.
export type SerpSelectors = {
  // Results column; the extractor falls back to <body> when none match.
  readonly root: string;
  // The title element of each organic result.
  readonly heading: string;
  // Result-block selectors, tried in order with closest(); the first match is the result's container.
  readonly containers: ReadonlyArray<string>;
  // Snippet element inside the container; without it the snippet is the container text minus the heading.
  readonly snippet?: string;
  // Breadcrumb element inside the container.
  readonly cite: string;
};

// A pluggable search engine. Engines are plain values mounted into an EngineRegistry (engines/registry.ts); nothing
// else in the search code knows which engines exist.
export type SearchEngine = {
  // Stable lower-case identifier the agent passes as `engine` ("google", "bing").
  readonly id: string;
  // Human name, used in error messages ("Bing served a CAPTCHA").
  readonly name: string;
  readonly buildUrl: (query: string, limit: number) => string;
  readonly selectors: SerpSelectors;
  // Lower-case phrases that mark a bot wall / challenge page.
  readonly captchaMarkers: ReadonlyArray<string>;
  // The anchor's external target, or undefined when it is not an organic web result.
  readonly resultUrl: (anchor: SerpAnchor, resolved: ResolvedTargets) => string | undefined;
  // For engines that render results with JavaScript after the load event: the tool waits (briefly) for this selector
  // to match before extracting. A page that never matches is still extracted and classified (captcha / no_results).
  readonly readySelector?: string;
  // Hrefs that can only be decoded by asking the engine's server for the redirect (Google /goto).
  readonly needsRedirectResolve?: (href: string) => boolean;
};

const CITE_SEPARATOR = /\s*›\s*/;
const TRUNCATION = /(?:\.\.\.|…)/;

export const isWebUrl = (url: string): boolean => {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    new URL(url);
    return true;
  } catch {
    return false;
  }
};

export const hostOf = (url: string): string | undefined => {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined;
  }
};

// Rebuilds a url from a visible breadcrumb cite. Segments after a truncation marker are unknowable, so the path stops
// at the last complete segment rather than guessing. Returns only urls `isResult` accepts.
export const urlFromCite = (cite: string, isResult: (url: string) => boolean): string | undefined => {
  const segments = cite
    .trim()
    .split(CITE_SEPARATOR)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  const origin = segments[0];
  if (origin === undefined || TRUNCATION.test(origin)) return undefined;
  // A cite naming any other scheme (ftp:, mailto:) is not a web result; prefixing it would forge a bogus https url.
  if (/^[a-z][a-z0-9+.-]*:/i.test(origin) && !/^https?:\/\//i.test(origin)) return undefined;
  const withScheme = /^https?:\/\//i.test(origin) ? origin : `https://${origin}`;
  const path: string[] = [];
  for (const segment of segments.slice(1)) {
    if (TRUNCATION.test(segment)) break;
    path.push(segment);
  }
  const url = [withScheme.replace(/\/$/, ""), ...path].join("/");
  return isResult(url) ? url : undefined;
};

// A web url whose host is not one of the engine's own properties.
export const externalResult =
  (isOwnHost: (host: string) => boolean) =>
  (url: string): boolean => {
    if (!isWebUrl(url)) return false;
    const host = hostOf(url);
    return host !== undefined && !isOwnHost(host);
  };

const dedupeKey = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
};

export const parseSerp = (
  engine: SearchEngine,
  anchors: ReadonlyArray<SerpAnchor>,
  limit: number,
  resolved: ResolvedTargets = new Map(),
): ReadonlyArray<SearchResult> => {
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const anchor of anchors) {
    if (results.length >= limit) break;
    const url = engine.resultUrl(anchor, resolved);
    if (url === undefined) continue;
    const key = dedupeKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({ title: anchor.heading.trim(), url, snippet: anchor.snippet.trim(), rank: results.length + 1 });
  }
  return results;
};

export const classifySerpWith = (
  captchaMarkers: ReadonlyArray<string>,
  pageText: string,
  resultCount: number,
  anchorCount: number,
): SerpVerdict => {
  if (resultCount > 0) return "ok";
  const lower = pageText.toLowerCase();
  if (captchaMarkers.some((marker) => lower.includes(marker))) return "captcha";
  // Anchors were found but every one was filtered out: the markup changed, not the result set.
  if (anchorCount > 0) return "extraction_mismatch";
  return "no_results";
};
