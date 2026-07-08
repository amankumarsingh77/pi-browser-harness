/**
 * Pure Google SERP parsing — no CDP, no browser. Everything here is a pure
 * function over data captured from the page, so it is unit-testable against
 * saved fixtures (see test/deep-research/serp-parser-test.ts).
 *
 * ADR-0001: results are extracted by structure/semantics (anchors carrying an
 * <h3> heading in the main results column), never by brittle Google CSS class
 * names, and Google redirect wrappers are unwound to the real target URL.
 */

/** One raw anchor captured in-page: a link with a heading and nearby snippet. */
export type SerpAnchor = {
  readonly href: string;
  readonly heading: string;
  readonly snippet: string;
};

/** The JSON payload the in-page extraction expression returns. */
export type SerpExtraction = {
  readonly anchors: ReadonlyArray<SerpAnchor>;
  readonly pageText: string;
};

/** A parsed, ranked search result — the tool's public output shape. */
export type SearchResult = {
  readonly title: string;
  readonly url: string;
  readonly snippet: string;
  readonly rank: number;
};

/** Why a SERP yielded no usable results, or that it did. */
export type SerpVerdict = "ok" | "captcha" | "no_results";

const CAPTCHA_MARKERS: ReadonlyArray<string> = [
  "unusual traffic",
  "not a robot",
  "recaptcha",
  "detected unusual",
  "systems have detected",
  "before you continue to google",
  "our systems have detected unusual traffic",
];

/**
 * Decode a Google redirect wrapper (`/url?q=<real>&sa=...`) to its target.
 * Returns the input unchanged when it is not a wrapper.
 */
const unwrapRedirect = (href: string): string => {
  const wrapper = href.match(/^(?:https?:\/\/[^/]*google\.[^/]*)?\/url\?/i);
  if (!wrapper) return href;
  const query = href.slice(href.indexOf("?") + 1);
  const target = new URLSearchParams(query).get("q");
  return target ?? href;
};

const isExternalResult = (url: string): boolean => {
  if (!/^https?:\/\//i.test(url)) return false;
  try {
    const host = new URL(url).hostname.toLowerCase();
    if (host === "google.com" || host.endsWith(".google.com")) return false;
    if (host === "googleusercontent.com" || host.endsWith(".googleusercontent.com")) return false;
    return true;
  } catch {
    return false;
  }
};

/** Normalized key for dedupe: origin + pathname, trailing slash and hash removed. */
const dedupeKey = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
};

/**
 * Parse captured anchors into ranked results: unwrap redirects, keep only
 * external http(s) links, dedupe by normalized url (first wins), rank by input
 * order, cap to `limit`.
 */
export const parseGoogleSerp = (anchors: ReadonlyArray<SerpAnchor>, limit: number): ReadonlyArray<SearchResult> => {
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const anchor of anchors) {
    if (results.length >= limit) break;
    const url = unwrapRedirect(anchor.href);
    if (!isExternalResult(url)) continue;
    const key = dedupeKey(url);
    if (seen.has(key)) continue;
    seen.add(key);
    results.push({
      title: anchor.heading.trim(),
      url,
      snippet: anchor.snippet.trim(),
      rank: results.length + 1,
    });
  }
  return results;
};

/**
 * Decide whether the SERP is usable, blocked by a CAPTCHA, or genuinely empty.
 * `resultCount` is the number of parsed results; `pageText` is a bounded slice
 * of the page's visible text.
 */
export const classifySerp = (pageText: string, resultCount: number): SerpVerdict => {
  if (resultCount > 0) return "ok";
  const lower = pageText.toLowerCase();
  if (CAPTCHA_MARKERS.some((marker) => lower.includes(marker))) return "captcha";
  return "no_results";
};
