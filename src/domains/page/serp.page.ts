// Page-side code for browser_web_search: pulls the organic result anchors off a Google results page. See fill.page.ts for the rules.

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

// Returns the extraction as JSON text (not an object) so the isolated-tab evaluator can keep its string guard.
export function extractSerp(pageTextLimit: number): string {
  const main = document.querySelector<HTMLElement>("#search, #rso, #main") ?? document.body;
  const headings = Array.from(main.querySelectorAll<HTMLElement>("a h3"));
  const seen = new Set<string>();
  const anchors: SerpAnchor[] = [];
  for (const h3 of headings) {
    const a = h3.closest<HTMLAnchorElement>("a[href]");
    if (!a) continue;
    const href = a.href;
    if (!href || seen.has(href)) continue;
    seen.add(href);
    const container: HTMLElement | null =
      a.closest<HTMLElement>("div.g") ??
      a.closest<HTMLElement>("div[data-hveid]") ??
      a.parentElement?.parentElement ??
      a.parentElement;
    const containerText = container ? container.innerText : "";
    const heading = h3.innerText || h3.textContent;
    const snippet = containerText.replace(heading, "").replace(/\s+/g, " ").trim().slice(0, 500);
    const citeEl = container ? container.querySelector<HTMLElement>("cite") : null;
    const cite = citeEl ? (citeEl.innerText || citeEl.textContent || "").trim() : "";
    anchors.push({ href, heading, snippet, cite });
  }
  const pageText = document.body.innerText.slice(0, pageTextLimit);
  const extraction: SerpExtraction = { anchors, pageText };
  return JSON.stringify(extraction);
}
