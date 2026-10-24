export type SerpAnchor = {
  readonly href: string;
  readonly heading: string;
  readonly snippet: string;
  // Visible breadcrumb url ("https://host › path › seg"); the only place the target survives once Google wraps hrefs in /goto.
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
  const wrapper = /^(?:https?:\/\/[^/]*google\.[^/]*)?\/url\?/i.exec(href);
  if (!wrapper) return href;
  const query = href.slice(href.indexOf("?") + 1);
  const target = new URLSearchParams(query).get("q");
  return target ?? href;
};

const CITE_SEPARATOR = /\s*›\s*/;
const TRUNCATION = /(?:\.\.\.|…)/;

// Rebuilds a url from Google's visible breadcrumb cite. Segments after a truncation marker are unknowable, so the
// path stops at the last complete segment rather than guessing.
export const urlFromCite = (cite: string): string | undefined => {
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
  return isExternalResult(url) ? url : undefined;
};

// Only a real Google /goto url counts: the daemon fetches these, so a look-alike host, userinfo, a port or http
// must never qualify. Hosts are google.com or www.google.<tld>, nothing else.
const GOOGLE_GOTO_HOST = /^(?:www\.)?google\.[a-z]{2,3}(?:\.[a-z]{2})?$/;
export const isGotoRedirect = (href: string): boolean => {
  try {
    const u = new URL(href);
    return (
      u.protocol === "https:" &&
      u.username === "" &&
      u.password === "" &&
      u.port === "" &&
      GOOGLE_GOTO_HOST.test(u.hostname.toLowerCase()) &&
      u.pathname === "/goto"
    );
  } catch {
    return false;
  }
};

export type ResolvedTargets = ReadonlyMap<string, string>;

// Direct external hrefs win. A /goto wrapper is opaque: the server-resolved redirect target is exact, and the cite is
// a display breadcrumb that only approximates the path, so it is the fallback when no target was resolved.
const resolveResultUrl = (anchor: SerpAnchor, resolved: ResolvedTargets): string | undefined => {
  const unwrapped = unwrapRedirect(anchor.href);
  if (isExternalResult(unwrapped)) return unwrapped;
  if (!isGotoRedirect(anchor.href)) return undefined;
  const target = resolved.get(anchor.href);
  if (target !== undefined && isExternalResult(target)) return target;
  if (anchor.cite !== undefined && anchor.cite.trim() !== "") return urlFromCite(anchor.cite);
  return undefined;
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

export const parseGoogleSerp = (
  anchors: ReadonlyArray<SerpAnchor>,
  limit: number,
  resolved: ResolvedTargets = new Map(),
): ReadonlyArray<SearchResult> => {
  const seen = new Set<string>();
  const results: SearchResult[] = [];
  for (const anchor of anchors) {
    if (results.length >= limit) break;
    const url = resolveResultUrl(anchor, resolved);
    if (url === undefined) continue;
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

export const classifySerp = (pageText: string, resultCount: number, anchorCount: number): SerpVerdict => {
  if (resultCount > 0) return "ok";
  const lower = pageText.toLowerCase();
  if (CAPTCHA_MARKERS.some((marker) => lower.includes(marker))) return "captcha";
  // Anchors were found but every one was filtered out: the markup changed, not the result set.
  if (anchorCount > 0) return "extraction_mismatch";
  return "no_results";
};
