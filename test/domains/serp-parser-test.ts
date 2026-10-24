import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { classifySerp, isGotoRedirect, parseGoogleSerp, urlFromCite, type SerpExtraction } from "../../src/domains/search/google-serp";
import { parseSerpExtraction } from "../../src/domains/search/web-search";

const fixture = (name: string): SerpExtraction => {
  const parsed = parseSerpExtraction(readFileSync(join(import.meta.dirname, "fixtures", name), "utf8"));
  if (!parsed.success) throw new Error(`fixture ${name} is not a SERP extraction: ${parsed.error}`);
  return parsed.data;
};

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
    assert.equal(classifySerp(ok.pageText, parseGoogleSerp(ok.anchors, 10).length, ok.anchors.length), "ok");
  });

  test("S3: captcha page classifies as captcha", () => {
    assert.equal(classifySerp(captcha.pageText, 0, 0), "captcha");
  });

  test("S3: empty results classify as no_results", () => {
    assert.equal(classifySerp(empty.pageText, 0, 0), "no_results");
  });
});

describe("Google /goto?url= redirect shape (issue #46)", () => {
  const goto = fixture("google-serp-goto.json");

  test("G1: a /goto anchor resolves its url from the cite origin", () => {
    const results = parseGoogleSerp(goto.anchors, 10);
    assert.equal(results[0]?.url, "https://www.typescriptlang.org");
    assert.equal(results[0].title, "TypeScript: JavaScript With Syntax For Types.");
  });

  test("G1: cite breadcrumb segments are rebuilt into a path", () => {
    const urls = parseGoogleSerp(goto.anchors, 10).map((r) => r.url);
    assert.ok(urls.includes("https://www.w3schools.com/typescript_intro"));
    assert.ok(urls.includes("https://en.wikipedia.org/wiki/TypeScript"));
  });

  test("G2: a truncated cite path degrades to the last complete segment", () => {
    const urls = parseGoogleSerp(goto.anchors, 10).map((r) => r.url);
    assert.ok(urls.includes("https://github.com/microsoft/TypeScript/issues"));
  });

  test("G2: a cite without a scheme gets https", () => {
    const results = parseGoogleSerp(
      [{ href: "https://www.google.com/goto?url=CAESx", heading: "h", snippet: "", cite: "example.org › docs" }],
      10,
    );
    assert.equal(results[0]?.url, "https://example.org/docs");
  });

  test("G2: a cite with a non-http scheme is rejected rather than prefixed with https", () => {
    assert.equal(urlFromCite("ftp://files.test › a"), undefined);
    assert.equal(urlFromCite("mailto:someone@x.test"), undefined);
    assert.equal(urlFromCite("HTTP://upper.test › p"), "HTTP://upper.test/p");
  });

  test("G3: a /goto anchor with no cite is dropped, not emitted as a google url", () => {
    const urls = parseGoogleSerp(goto.anchors, 10).map((r) => r.url);
    assert.ok(!urls.some((u) => u.includes("google.com")));
    assert.equal(urls.length, 4);
  });

  test("G3: a direct external href still wins over the cite", () => {
    const results = parseGoogleSerp(
      [{ href: "https://real.example/full/path?x=1", heading: "h", snippet: "", cite: "https://real.example › full" }],
      10,
    );
    assert.equal(results[0]?.url, "https://real.example/full/path?x=1");
  });

  test("G4: anchors present but nothing parsed classifies as extraction_mismatch", () => {
    assert.equal(classifySerp(goto.pageText, 0, goto.anchors.length), "extraction_mismatch");
  });

  test("G4: no anchors at all still classifies as no_results", () => {
    assert.equal(classifySerp(empty.pageText, 0, 0), "no_results");
  });

  test("G4: captcha wins over extraction_mismatch", () => {
    assert.equal(classifySerp(captcha.pageText, 0, 3), "captcha");
  });

  test("G5: anchors without a cite field still validate (old extraction shape)", () => {
    assert.equal(parseSerpExtraction(JSON.stringify({ anchors: [{ href: "h", heading: "t", snippet: "" }], pageText: "" })).success, true);
  });
});

describe("resolved /goto targets", () => {
  test("R1: a resolved redirect target wins over the cite (cite is only a display path)", () => {
    const anchor = {
      href: "https://www.google.com/goto?url=CAESdAHr",
      heading: "TypeScript Introduction",
      snippet: "",
      cite: "https://www.w3schools.com › typescript_intro",
    };
    const resolved = new Map([[anchor.href, "https://www.w3schools.com/typescript/typescript_intro.php"]]);
    const results = parseGoogleSerp([anchor], 10, resolved);
    assert.equal(results[0]?.url, "https://www.w3schools.com/typescript/typescript_intro.php");
  });

  test("R2: an unresolved /goto anchor falls back to the cite", () => {
    const anchor = { href: "https://www.google.com/goto?url=CAESx", heading: "h", snippet: "", cite: "https://a.example › p" };
    const results = parseGoogleSerp([anchor], 10, new Map());
    assert.equal(results[0]?.url, "https://a.example/p");
  });

  test("R3: a ccTLD /goto href is never emitted verbatim; it resolves or falls back to the cite", () => {
    const href = "https://www.google.co.uk/goto?url=CAESx";
    const cite = "https://a.example › p";
    const viaCite = parseGoogleSerp([{ href, heading: "h", snippet: "", cite }], 10, new Map());
    assert.equal(viaCite[0]?.url, "https://a.example/p");
    const viaTarget = parseGoogleSerp([{ href, heading: "h", snippet: "", cite }], 10, new Map([[href, "https://real.example/x"]]));
    assert.equal(viaTarget[0]?.url, "https://real.example/x");
  });

  test("R3: a resolved target on a Google ccTLD (sorry/consent page) is ignored and the cite is used", () => {
    const anchor = { href: "https://www.google.com/goto?url=CAESx", heading: "h", snippet: "", cite: "https://a.example" };
    for (const target of ["https://www.google.de/sorry/index", "https://consent.google.co.uk/m", "https://google.com.au/search"]) {
      const results = parseGoogleSerp([anchor], 10, new Map([[anchor.href, target]]));
      assert.equal(results[0]?.url, "https://a.example", target);
    }
  });

  test("R3: a resolved target on google.com is ignored and the cite is used", () => {
    const anchor = { href: "https://www.google.com/goto?url=CAESx", heading: "h", snippet: "", cite: "https://a.example" };
    const resolved = new Map([[anchor.href, "https://www.google.com/sorry/index"]]);
    const results = parseGoogleSerp([anchor], 10, resolved);
    assert.equal(results[0]?.url, "https://a.example");
  });
});

describe("isGotoRedirect only accepts a real Google /goto url", () => {
  test("accepts https://www.google.<tld>/goto and bare google.com", () => {
    assert.equal(isGotoRedirect("https://www.google.com/goto?url=CAES"), true);
    assert.equal(isGotoRedirect("https://www.google.co.uk/goto?url=CAES"), true);
    assert.equal(isGotoRedirect("https://google.com/goto?url=CAES"), true);
  });

  test("rejects look-alike hosts, userinfo tricks, ports, http and other paths", () => {
    for (const href of [
      "https://attacker-google.com/goto?url=x",
      "https://google.com.evil.test/goto?url=x",
      "https://google.com@169.254.169.254/goto?url=x",
      "https://www.google.com:8443/goto?url=x",
      "http://www.google.com/goto?url=x",
      "https://www.google.com/gotox?url=x",
      "https://www.google.com/search/goto?url=x",
      "/goto?url=x",
      "javascript:alert(1)",
    ]) assert.equal(isGotoRedirect(href), false, href);
  });
});
