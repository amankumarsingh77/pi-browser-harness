/**
 * Unit tests for the pure readability extractor — no browser required.
 *
 * Run: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { extractReadable, type PageCapture } from "../../src/domains/readpage/readability";

const fixture = (name: string): PageCapture =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as PageCapture;

describe("pure readability extractor", () => {
  // S10: boilerplate stripped, article content preserved
  test("S10: article body text is present", () => {
    const page = extractReadable(fixture("article-capture.json"));
    assert.ok(page.text.includes("Chrome DevTools Protocol lets tools instrument"));
  });

  test("S10: article headings are preserved", () => {
    const page = extractReadable(fixture("article-capture.json"));
    assert.ok(page.text.includes("Sessions and Targets"));
  });

  test("S10: nav boilerplate is dropped", () => {
    const page = extractReadable(fixture("article-capture.json"));
    assert.ok(!page.text.includes("Home Products Blog"));
  });

  test("S10: footer boilerplate is dropped", () => {
    const page = extractReadable(fixture("article-capture.json"));
    assert.ok(!page.text.includes("Copyright 2026"));
  });

  test("S10: high-link-density promo block is dropped", () => {
    const page = extractReadable(fixture("article-capture.json"));
    assert.ok(!page.text.includes("Subscribe here for our newsletter"));
  });

  test("S10: paragraph/heading structure preserved as markdown", () => {
    const page = extractReadable(fixture("article-capture.json"));
    assert.ok(page.text.includes("## Sessions and Targets"));
  });

  test("S10: title and url passed through", () => {
    const page = extractReadable(fixture("article-capture.json"));
    assert.ok(page.title === "How the Chrome DevTools Protocol Works" && page.url.startsWith("https://"));
  });

  test("S10: word count reflects the article body", () => {
    const page = extractReadable(fixture("article-capture.json"));
    assert.ok(page.wordCount > 40);
  });

  // S11: no clear article node falls back to bounded body text
  test("S11: structure-less page falls back to non-empty body text", () => {
    const page = extractReadable(fixture("no-article-capture.json"));
    assert.ok(page.text.length > 0);
  });

  test("S11: fallback body text carries the real content", () => {
    const page = extractReadable(fixture("no-article-capture.json"));
    assert.ok(page.text.includes("Your account is active"));
  });
});
