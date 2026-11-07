import { externalResult, isWebUrl, type SearchEngine, type SerpAnchor, urlFromCite } from "../serp";

const BING_PROPERTY = /(?:^|\.)bing\.(?:com|net)$/;
const isExternalResult = externalResult((host) => BING_PROPERTY.test(host));

// Bing wraps organic links as bing.com/ck/a?...&u=a1<base64url(target)>. The "a1" prefix tags the encoding.
export const decodeBingClick = (href: string): string | undefined => {
  try {
    const u = new URL(href);
    if (!BING_PROPERTY.test(u.hostname.toLowerCase()) || u.pathname !== "/ck/a") return undefined;
    const encoded = u.searchParams.get("u");
    if (!encoded?.startsWith("a1")) return undefined;
    const decoded = Buffer.from(encoded.slice(2), "base64url").toString("utf8");
    return isWebUrl(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
};

const resultUrl = (anchor: SerpAnchor): string | undefined => {
  const target = decodeBingClick(anchor.href) ?? anchor.href;
  if (isExternalResult(target)) return target;
  if (anchor.cite !== undefined && anchor.cite.trim() !== "") return urlFromCite(anchor.cite, isExternalResult);
  return undefined;
};

export const bing: SearchEngine = {
  id: "bing",
  name: "Bing",
  buildUrl: (query, limit) =>
    `https://www.bing.com/search?q=${encodeURIComponent(query)}&count=${limit}&setlang=en`,
  selectors: {
    root: "#b_results, #b_content",
    heading: "li.b_algo h2",
    containers: ["li.b_algo"],
    snippet: ".b_caption p, p[class*='b_lineclamp'], .b_snippet",
    cite: "cite",
  },
  captchaMarkers: [
    "one last step",
    "solve the challenge",
    "verify you are a human",
    "unusual traffic",
    "are you a robot",
  ],
  resultUrl,
};
