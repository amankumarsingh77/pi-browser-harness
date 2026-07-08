/**
 * Unit tests for the pure readability extractor — no browser required.
 *
 * Run: npx tsx test/deep-research/readability-test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractReadable, type PageCapture } from "../../src/domains/readpage/readability";

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string): void => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
};

const fixture = (name: string): PageCapture =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as PageCapture;

// S10: boilerplate stripped, article content preserved
{
  const page = extractReadable(fixture("article-capture.json"));
  check(page.text.includes("Chrome DevTools Protocol lets tools instrument"), "S10: article body text is present");
  check(page.text.includes("Sessions and Targets"), "S10: article headings are preserved");
  check(!page.text.includes("Home Products Blog"), "S10: nav boilerplate is dropped");
  check(!page.text.includes("Copyright 2026"), "S10: footer boilerplate is dropped");
  check(!page.text.includes("Subscribe here for our newsletter"), "S10: high-link-density promo block is dropped");
  check(page.text.includes("## Sessions and Targets"), "S10: paragraph/heading structure preserved as markdown");
  check(page.title === "How the Chrome DevTools Protocol Works" && page.url.startsWith("https://"), "S10: title and url passed through");
  check(page.wordCount > 40, "S10: word count reflects the article body");
}

// S11: no clear article node falls back to bounded body text
{
  const page = extractReadable(fixture("no-article-capture.json"));
  check(page.text.length > 0, "S11: structure-less page falls back to non-empty body text");
  check(page.text.includes("Your account is active"), "S11: fallback body text carries the real content");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
