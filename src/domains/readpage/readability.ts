
export type ContentBlock = {
  readonly kind: "paragraph" | "heading" | "listitem" | "blockquote" | "other";
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
