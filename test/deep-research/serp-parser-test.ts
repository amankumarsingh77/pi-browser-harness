/**
 * Unit tests for the pure Google SERP parser — no browser required.
 *
 * Run: npx tsx test/deep-research/serp-parser-test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifySerp, parseGoogleSerp, type SerpExtraction } from "../../src/domains/search/google-serp";

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

const fixture = (name: string): SerpExtraction =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as SerpExtraction;

const ok = fixture("google-serp-ok.json");
const captcha = fixture("google-serp-captcha.json");
const empty = fixture("google-serp-empty.json");

// S1: redirect unwrapping + internal/javascript anchors dropped
{
  const results = parseGoogleSerp(ok.anchors, 10);
  const urls = results.map((r) => r.url);
  check(urls.includes("https://real.example/x"), "S1: /url?q= redirect is unwrapped to the real target");
  check(!urls.some((u) => u.includes("google.com")), "S1: google-internal anchors are dropped");
  check(!urls.some((u) => u.startsWith("javascript:")), "S1: javascript: anchors are dropped");
}

// S2: dedupe + rank + limit
{
  const results = parseGoogleSerp(ok.anchors, 10);
  const realExampleCount = results.filter((r) => r.url.startsWith("https://real.example/x")).length;
  check(realExampleCount === 1, "S2: trailing-slash duplicate collapses to one result");
  check(
    results.every((r, i) => r.rank === i + 1),
    "S2: rank runs 1..n in input order",
  );
  const capped = parseGoogleSerp(ok.anchors, 2);
  check(capped.length === 2 && capped[capped.length - 1]?.rank === 2, "S2: limit truncates and ranks stay 1..limit");
}

// S3: CAPTCHA / no-results classification
{
  check(classifySerp(ok.pageText, parseGoogleSerp(ok.anchors, 10).length) === "ok", "S3: populated SERP classifies as ok");
  check(classifySerp(captcha.pageText, 0) === "captcha", "S3: captcha page classifies as captcha");
  check(classifySerp(empty.pageText, 0) === "no_results", "S3: empty results classify as no_results");
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
