/**
 * Pure reader-mode extraction — no CDP, no DOM. The in-page script
 * (see capture.ts) serializes candidate content blocks; these pure functions
 * score them and assemble clean article text, so the selection logic is
 * unit-testable against saved fixtures (test/deep-research/readability-test.ts).
 *
 * Dependency-free by design (no jsdom / Readability): the harness ships no new
 * runtime deps. The heuristic favors blocks with high text density and low link
 * density, which is what separates article body from nav/ads/boilerplate.
 */

/** One candidate content block captured in-page. */
export type ContentBlock = {
  /** Semantic tag: paragraph | heading | listitem | blockquote | other. */
  readonly kind: "paragraph" | "heading" | "listitem" | "blockquote" | "other";
  readonly text: string;
  /** Chars of text that sit inside <a> tags — high ratio ⇒ nav/menu, not prose. */
  readonly linkTextLength: number;
  /** True when an ancestor is nav/header/footer/aside — structural boilerplate. */
  readonly inBoilerplate: boolean;
};

/** The JSON payload capture.ts returns from the page. */
export type PageCapture = {
  readonly url: string;
  readonly title: string;
  readonly blocks: ReadonlyArray<ContentBlock>;
  /** Bounded innerText fallback when block extraction finds nothing usable. */
  readonly bodyText: string;
};

/** The tool's public output shape. */
export type ReadablePage = {
  readonly title: string;
  readonly url: string;
  readonly text: string;
  readonly wordCount: number;
};

const MIN_PARAGRAPH_CHARS = 25;
const MAX_LINK_DENSITY = 0.5;
const MIN_ARTICLE_WORDS = 40;

const linkDensity = (block: ContentBlock): number => {
  if (block.text.length === 0) return 1;
  return block.linkTextLength / block.text.length;
};

/** A block is article prose if it is substantive, text-dense, and not chrome. */
const isArticleBlock = (block: ContentBlock): boolean => {
  if (block.inBoilerplate) return false;
  if (linkDensity(block) > MAX_LINK_DENSITY) return false;
  if (block.kind === "heading" || block.kind === "blockquote" || block.kind === "listitem") {
    return block.text.trim().length > 0;
  }
  return block.text.trim().length >= MIN_PARAGRAPH_CHARS;
};

const render = (block: ContentBlock): string => {
  const text = block.text.trim();
  if (block.kind === "heading") return `\n## ${text}\n`;
  if (block.kind === "listitem") return `- ${text}`;
  if (block.kind === "blockquote") return `> ${text}`;
  return text;
};

const wordCountOf = (text: string): number => {
  const trimmed = text.trim();
  return trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
};

/**
 * Assemble readable article text from a page capture. Keeps text-dense,
 * non-boilerplate blocks; falls back to the bounded body text when the article
 * is too thin (e.g. a page with no clear content structure).
 */
export const extractReadable = (capture: PageCapture): ReadablePage => {
  const articleText = capture.blocks.filter(isArticleBlock).map(render).join("\n\n").replace(/\n{3,}/g, "\n\n").trim();

  const useFallback = wordCountOf(articleText) < MIN_ARTICLE_WORDS;
  const text = useFallback ? capture.bodyText.trim() : articleText;

  return {
    title: capture.title.trim(),
    url: capture.url,
    text,
    wordCount: wordCountOf(text),
  };
};
