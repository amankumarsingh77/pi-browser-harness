import { externalResult, type SearchEngine, type SerpAnchor, urlFromCite } from "../serp";

const DDG_PROPERTY = /(?:^|\.)duckduckgo\.com$/;
const isExternalResult = externalResult((host) => DDG_PROPERTY.test(host));

// Results normally link straight to the target; a duckduckgo.com/l/?uddg=<encoded target> wrapper is undone, and ads
// (routed through /y.js) are dropped by the own-property filter.
export const unwrapDuckDuckGo = (href: string): string => {
  try {
    const u = new URL(href);
    if (!DDG_PROPERTY.test(u.hostname.toLowerCase()) || u.pathname !== "/l/") return href;
    return u.searchParams.get("uddg") ?? href;
  } catch {
    return href;
  }
};

const resultUrl = (anchor: SerpAnchor): string | undefined => {
  const target = unwrapDuckDuckGo(anchor.href);
  if (isExternalResult(target)) return target;
  if (anchor.cite !== undefined && anchor.cite.trim() !== "") return urlFromCite(anchor.cite, isExternalResult);
  return undefined;
};

// The main results page. It renders results with JavaScript after the load event, hence readySelector. (The no-JS
// html.duckduckgo.com endpoint serves a bot challenge even to a real Chrome, so it is not used.)
export const duckduckgo: SearchEngine = {
  id: "duckduckgo",
  name: "DuckDuckGo",
  buildUrl: (query) => `https://duckduckgo.com/?q=${encodeURIComponent(query)}&kl=us-en&ia=web`,
  selectors: {
    // The page has two mainline containers and the first is empty, so the root is the results list itself.
    root: ".react-results--main, #react-layout",
    heading: "article[data-testid='result'] a[data-testid='result-title-a']",
    containers: ["article[data-testid='result']"],
    snippet: "[data-result='snippet']",
    cite: "a[data-testid='result-extras-url-link']",
  },
  captchaMarkers: ["bots use duckduckgo too", "complete the following challenge"],
  readySelector: "article[data-testid='result']",
  resultUrl,
};
