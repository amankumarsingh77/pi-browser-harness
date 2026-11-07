import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createEngineRegistry, defaultEngines } from "../../src/domains/search/engines";
import { bing, decodeBingClick } from "../../src/domains/search/engines/bing";
import { duckduckgo } from "../../src/domains/search/engines/duckduckgo";
import { brave } from "../../src/domains/search/engines/brave";
import { google } from "../../src/domains/search/engines/google";
import { parseSerp } from "../../src/domains/search/serp";

const b64 = (url: string): string => Buffer.from(url, "utf8").toString("base64url");

describe("engine registry", () => {
  test("mount order is the ladder and lookups are by id", () => {
    const registry = createEngineRegistry().mount(bing).mount(google);
    assert.deepEqual(registry.ids(), ["bing", "google"]);
    assert.deepEqual(registry.ladder().map((e) => e.id), ["bing", "google"]);
    assert.equal(registry.get("google"), google);
    assert.equal(registry.get("yahoo"), undefined);
  });

  test("mount returns a new registry and leaves the original untouched", () => {
    const base = createEngineRegistry().mount(google);
    const more = base.mount(bing);
    assert.deepEqual(base.ids(), ["google"]);
    assert.deepEqual(more.ids(), ["google", "bing"]);
  });

  test("mounting a duplicate or malformed id throws", () => {
    assert.throws(() => createEngineRegistry().mount(google).mount(google), /already mounted/);
    assert.throws(() => createEngineRegistry().mount({ ...google, id: "Bad Id" }), /must match/);
  });

  test("the default ladder is google → bing → duckduckgo → brave", () => {
    assert.deepEqual(defaultEngines().ids(), ["google", "bing", "duckduckgo", "brave"]);
  });
});

describe("bing", () => {
  test("builds a SERP url with the result count", () => {
    assert.equal(bing.buildUrl("a b", 5), "https://www.bing.com/search?q=a%20b&count=5&setlang=en");
  });

  test("decodes the /ck/a click wrapper to its base64url target", () => {
    const href = `https://www.bing.com/ck/a?!&&p=abc&u=a1${b64("https://www.typescriptlang.org/docs/handbook/")}&ntb=1`;
    assert.equal(decodeBingClick(href), "https://www.typescriptlang.org/docs/handbook/");
    assert.equal(decodeBingClick("https://www.bing.com/ck/a?u=zz"), undefined);
    assert.equal(decodeBingClick(`https://evil.test/ck/a?u=a1${b64("https://x.test/")}`), undefined);
  });

  test("keeps decoded and direct external results, drops Bing's own pages, and falls back to the cite", () => {
    const results = parseSerp(bing, [
      { href: `https://www.bing.com/ck/a?u=a1${b64("https://one.test/a")}`, heading: "One", snippet: "s1" },
      { href: "https://two.test/b", heading: "Two", snippet: "s2" },
      { href: "https://www.bing.com/images/search?q=x", heading: "Images", snippet: "" },
      { href: "https://www.bing.com/ck/a?u=broken", heading: "Three", snippet: "s3", cite: "https://three.test › docs" },
    ], 10);
    assert.deepEqual(results.map((r) => r.url), ["https://one.test/a", "https://two.test/b", "https://three.test/docs"]);
  });
});

describe("duckduckgo", () => {
  test("unwraps /l/?uddg= links and drops /y.js ads", () => {
    const results = parseSerp(duckduckgo, [
      { href: "https://duckduckgo.com/l/?uddg=https%3A%2F%2Fone.test%2Fa&rut=x", heading: "One", snippet: "" },
      { href: "https://duckduckgo.com/y.js?ad_domain=ads.test", heading: "Ad", snippet: "" },
      { href: "https://two.test/", heading: "Two", snippet: "" },
    ], 10);
    assert.deepEqual(results.map((r) => r.url), ["https://one.test/a", "https://two.test/"]);
  });

  test("uses the main results page and waits for rendered results", () => {
    assert.equal(duckduckgo.buildUrl("a b", 10), "https://duckduckgo.com/?q=a%20b&kl=us-en&ia=web");
  });
});

describe("brave", () => {
  test("keeps direct external links and drops Brave's own pages", () => {
    const results = parseSerp(brave, [
      { href: "https://one.test/", heading: "One", snippet: "" },
      { href: "https://search.brave.com/images?q=x", heading: "Images", snippet: "" },
    ], 10);
    assert.deepEqual(results.map((r) => r.url), ["https://one.test/"]);
  });
});
