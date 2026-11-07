import {
  classifySerpWith,
  externalResult,
  parseSerp,
  type ResolvedTargets,
  type SearchEngine,
  type SearchResult,
  type SerpAnchor,
  type SerpVerdict,
  urlFromCite,
} from "../serp";

const CAPTCHA_MARKERS: ReadonlyArray<string> = [
  "unusual traffic",
  "not a robot",
  "recaptcha",
  "detected unusual",
  "systems have detected",
  "before you continue to google",
  "our systems have detected unusual traffic",
];

// Any Google property, on any TLD (google.com, google.co.uk, consent.google.de, googleusercontent.com), is never a
// result: a sorry or consent page is where a rate-limited /goto redirect lands.
const GOOGLE_PROPERTY = /(?:^|\.)google(?:usercontent)?\.(?:com?\.[a-z]{2}|[a-z]{2,3})$/;

const isExternalResult = externalResult((host) => GOOGLE_PROPERTY.test(host));

const unwrapRedirect = (href: string): string => {
  const wrapper = /^(?:https?:\/\/[^/]*google\.[^/]*)?\/url\?/i.exec(href);
  if (!wrapper) return href;
  const query = href.slice(href.indexOf("?") + 1);
  const target = new URLSearchParams(query).get("q");
  return target ?? href;
};

// Rebuilds a url from Google's visible breadcrumb cite, the only place the target survives once Google wraps hrefs
// in /goto.
export const googleUrlFromCite = (cite: string): string | undefined => urlFromCite(cite, isExternalResult);

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

// Direct external hrefs win. A /goto wrapper is opaque: the server-resolved redirect target is exact, and the cite is
// a display breadcrumb that only approximates the path, so it is the fallback when no target was resolved.
const resultUrl = (anchor: SerpAnchor, resolved: ResolvedTargets): string | undefined => {
  if (!isGotoRedirect(anchor.href)) {
    const unwrapped = unwrapRedirect(anchor.href);
    return isExternalResult(unwrapped) ? unwrapped : undefined;
  }
  const target = resolved.get(anchor.href);
  if (target !== undefined && isExternalResult(target)) return target;
  if (anchor.cite !== undefined && anchor.cite.trim() !== "") return googleUrlFromCite(anchor.cite);
  return undefined;
};

export const google: SearchEngine = {
  id: "google",
  name: "Google",
  buildUrl: (query, limit) => `https://www.google.com/search?q=${encodeURIComponent(query)}&num=${limit}&hl=en`,
  selectors: {
    root: "#search, #rso, #main",
    heading: "a h3",
    containers: ["div.g", "div[data-hveid]"],
    cite: "cite",
  },
  captchaMarkers: CAPTCHA_MARKERS,
  resultUrl,
  needsRedirectResolve: isGotoRedirect,
};

export const parseGoogleSerp = (
  anchors: ReadonlyArray<SerpAnchor>,
  limit: number,
  resolved: ResolvedTargets = new Map(),
): ReadonlyArray<SearchResult> => parseSerp(google, anchors, limit, resolved);

export const classifyGoogleSerp = (pageText: string, resultCount: number, anchorCount: number): SerpVerdict =>
  classifySerpWith(CAPTCHA_MARKERS, pageText, resultCount, anchorCount);
