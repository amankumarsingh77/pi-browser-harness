// Page-side code for browser_web_search: pulls the organic result anchors off a search engine's results page, driven
// by the engine's selectors. See fill.page.ts for the rules.

export type SerpAnchor = {
  readonly href: string;
  readonly heading: string;
  readonly snippet: string;
  readonly cite?: string;
};

export type SerpExtraction = {
  readonly anchors: ReadonlyArray<SerpAnchor>;
  readonly pageText: string;
};

export type SerpSelectors = {
  readonly root: string;
  readonly heading: string;
  readonly containers: ReadonlyArray<string>;
  readonly snippet?: string;
  readonly cite: string;
};

// Returns the extraction as JSON text (not an object) so the isolated-tab evaluator can keep its string guard.
export function extractSerp(selectors: SerpSelectors, pageTextLimit: number): string {
  const main = document.querySelector<HTMLElement>(selectors.root) ?? document.body;
  const headings = Array.from(main.querySelectorAll<HTMLElement>(selectors.heading));
  const seen = new Set<string>();
  const anchors: SerpAnchor[] = [];
  for (const heading of headings) {
    // The heading is the link (DuckDuckGo), sits inside it (Google, Brave) or wraps it (Bing).
    const a = heading.closest<HTMLAnchorElement>("a[href]") ?? heading.querySelector<HTMLAnchorElement>("a[href]");
    if (!a) continue;
    const href = a.href;
    if (!href || seen.has(href)) continue;
    seen.add(href);
    let container: HTMLElement | null = null;
    for (const selector of selectors.containers) {
      container = a.closest<HTMLElement>(selector);
      if (container) break;
    }
    container = container ?? a.parentElement?.parentElement ?? a.parentElement;
    const title = heading.innerText || heading.textContent || "";
    const snippetEl =
      selectors.snippet !== undefined && container ? container.querySelector<HTMLElement>(selectors.snippet) : null;
    const snippetSource = snippetEl ? snippetEl.innerText : container ? container.innerText.replace(title, "") : "";
    const snippet = snippetSource.replace(/\s+/g, " ").trim().slice(0, 500);
    const citeEl = container ? container.querySelector<HTMLElement>(selectors.cite) : null;
    const cite = citeEl ? (citeEl.innerText || citeEl.textContent || "").trim() : "";
    anchors.push({ href, heading: title, snippet, cite });
  }
  const pageText = document.body.innerText.slice(0, pageTextLimit);
  const extraction: SerpExtraction = { anchors, pageText };
  return JSON.stringify(extraction);
}
