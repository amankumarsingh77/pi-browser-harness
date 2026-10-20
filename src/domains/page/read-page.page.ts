// Page-side code for browser_read_page. See fill.page.ts for the rules.

export type ContentBlockKind = "paragraph" | "heading" | "listitem" | "blockquote" | "other";

export type ContentBlock = {
  readonly kind: ContentBlockKind;
  readonly text: string;
  readonly linkTextLength: number;
  readonly inBoilerplate: boolean;
};

export type PageCapture = {
  readonly url: string;
  readonly title: string;
  readonly blocks: ReadonlyArray<ContentBlock>;
  readonly bodyText: string;
};

// Returns the capture as JSON text (not an object) so the isolated-tab evaluator can keep its string guard.
export function capturePage(bodyTextLimit: number): string {
  const BOILERPLATE = new Set(["NAV", "HEADER", "FOOTER", "ASIDE"]);
  const selector = "p, h1, h2, h3, h4, h5, h6, li, blockquote";
  const root = document.querySelector("article, main, [role=main]") ?? document.body;
  const blocks: ContentBlock[] = [];
  for (const el of root.querySelectorAll<HTMLElement>(selector)) {
    const text = el.innerText.replace(/\s+/g, " ").trim();
    if (!text) continue;
    let linkTextLength = 0;
    for (const a of el.querySelectorAll("a")) linkTextLength += a.innerText.length;
    const tag = el.tagName;
    const kind: ContentBlockKind = /^H[1-6]$/.test(tag)
      ? "heading"
      : tag === "LI"
        ? "listitem"
        : tag === "BLOCKQUOTE"
          ? "blockquote"
          : tag === "P"
            ? "paragraph"
            : "other";
    // Inside nav/header/footer/aside (by tag or landmark role) at any depth.
    let inBoilerplate = false;
    for (let n: Element | null = el; n && !inBoilerplate; n = n.parentElement) {
      const role = n.getAttribute("role");
      inBoilerplate = BOILERPLATE.has(n.tagName) || role === "navigation" || role === "banner" || role === "contentinfo";
    }
    blocks.push({ kind, text, linkTextLength, inBoilerplate });
  }
  const bodyText = document.body.innerText.replace(/\n{3,}/g, "\n\n").slice(0, bodyTextLimit);
  const capture: PageCapture = { url: location.href, title: document.title, blocks, bodyText };
  return JSON.stringify(capture);
}
