import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifySerp, parseGoogleSerp, type SerpExtraction } from "../../src/domains/search/google-serp";

const fixture = (name: string): SerpExtraction =>
  JSON.parse(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8")) as SerpExtraction;

const ok = fixture("google-serp-ok.json");
const captcha = fixture("google-serp-captcha.json");
const empty = fixture("google-serp-empty.json");

describe("pure Google SERP parser", () => {
  test("S1: /url?q= redirect is unwrapped to the real target", () => {
    const results = parseGoogleSerp(ok.anchors, 10);
    const urls = results.map((r) => r.url);
    assert.ok(urls.includes("https://real.example/x"));
  });

  test("S1: google-internal anchors are dropped", () => {
    const results = parseGoogleSerp(ok.anchors, 10);
    const urls = results.map((r) => r.url);
    assert.ok(!urls.some((u) => u.includes("google.com")));
  });

  test("S1: javascript: anchors are dropped", () => {
    const results = parseGoogleSerp(ok.anchors, 10);
    const urls = results.map((r) => r.url);
    assert.ok(!urls.some((u) => u.startsWith("javascript:")));
  });

  test("S2: trailing-slash duplicate collapses to one result", () => {
    const results = parseGoogleSerp(ok.anchors, 10);
    const realExampleCount = results.filter((r) => r.url.startsWith("https://real.example/x")).length;
    assert.equal(realExampleCount, 1);
  });

  test("S2: rank runs 1..n in input order", () => {
    const results = parseGoogleSerp(ok.anchors, 10);
    assert.ok(results.every((r, i) => r.rank === i + 1));
  });

  test("S2: limit truncates and ranks stay 1..limit", () => {
    const capped = parseGoogleSerp(ok.anchors, 2);
    assert.ok(capped.length === 2 && capped[capped.length - 1]?.rank === 2);
  });

  test("S3: populated SERP classifies as ok", () => {
    assert.equal(classifySerp(ok.pageText, parseGoogleSerp(ok.anchors, 10).length), "ok");
  });

  test("S3: captcha page classifies as captcha", () => {
    assert.equal(classifySerp(captcha.pageText, 0), "captcha");
  });

  test("S3: empty results classify as no_results", () => {
    assert.equal(classifySerp(empty.pageText, 0), "no_results");
  });
});
