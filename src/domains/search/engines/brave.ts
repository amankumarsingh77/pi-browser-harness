import { externalResult, type SearchEngine, type SerpAnchor } from "../serp";

const BRAVE_PROPERTY = /(?:^|\.)brave\.com$/;
const isExternalResult = externalResult((host) => BRAVE_PROPERTY.test(host));

// Brave links straight to the target; there is no redirect wrapper to undo.
const resultUrl = (anchor: SerpAnchor): string | undefined =>
  isExternalResult(anchor.href) ? anchor.href : undefined;

export const brave: SearchEngine = {
  id: "brave",
  name: "Brave Search",
  buildUrl: (query) => `https://search.brave.com/search?q=${encodeURIComponent(query)}&source=web`,
  selectors: {
    root: "#results, main",
    heading: "[data-type='web'] a .title",
    containers: ["[data-type='web']"],
    snippet: ".generic-snippet .content, .snippet-description",
    cite: "cite",
  },
  captchaMarkers: ["captcha", "verify you are human", "unusual activity", "not a robot"],
  resultUrl,
};
