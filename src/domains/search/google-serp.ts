
export type SerpAnchor = {
  readonly href: string;
  readonly heading: string;
  readonly snippet: string;
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

const dedupeKey = (url: string): string => {
  try {
    const u = new URL(url);
    return `${u.origin}${u.pathname.replace(/\/$/, "")}`.toLowerCase();
  } catch {
    return url.toLowerCase();
  }
};

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

export const classifySerp = (pageText: string, resultCount: number): SerpVerdict => {
  if (resultCount > 0) return "ok";
  const lower = pageText.toLowerCase();
  if (CAPTCHA_MARKERS.some((marker) => lower.includes(marker))) return "captcha";
  return "no_results";
};
