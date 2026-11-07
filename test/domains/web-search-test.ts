import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { type Canned, createFakeClient, evaluated, type FakeClient, handlerContext } from "./fake-client";
import { installTheme, renderWith, renderedText, withClient } from "./client-overrides";
import { createWebSearchTool, parseSerpExtraction, webSearchTool } from "../../src/domains/search/web-search";
import type { SearchEngine, SerpExtraction } from "../../src/domains/search/serp";
import { createEngineRegistry, defaultEngines } from "../../src/domains/search/engines";
import { fetchRedirectTarget } from "../../src/domains/search/redirect-resolver";
import { cdpError } from "../../src/cdp/errors";
import { err, ok } from "../../src/util/result";
import { asArrayOf, asRecord } from "../../src/util/guards";

const EXTRACTION: SerpExtraction = {
  anchors: [
    { href: "https://www.google.com/search?q=more", heading: "More results", snippet: "" },
    { href: "https://first.test/a", heading: " First ", snippet: " one " },
    { href: "/url?q=https%3A%2F%2Fsecond.test%2Fb&sa=U", heading: "Second", snippet: "two" },
    { href: "https://first.test/a/", heading: "First again", snippet: "dupe" },
    { href: "https://third.test/c", heading: "Third", snippet: "three" },
  ],
  pageText: "results",
};

const searching = (canned: Canned = {}): Promise<FakeClient> =>
  createFakeClient({
    canned: {
      "Target.createTarget": ok({ targetId: "t2" }),
      "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-iso" })],
      "Page.navigate": ok({ frameId: "f" }),
      "Runtime.evaluate": evaluated(JSON.stringify(EXTRACTION)),
      ...canned,
    },
    evaluate: (expression) => ok(expression.includes("readyState") ? true : undefined),
  });

const render = renderWith(webSearchTool);

const closing = (fake: FakeClient): { client: ReturnType<typeof withClient>; closed: string[] } => {
  const closed: string[] = [];
  const client = withClient(fake.client, {
    closeTab: (id) => {
      closed.push(id);
      return Promise.resolve(ok(undefined));
    },
  });
  return { client, closed };
};

describe("browser_web_search", () => {
  test("navigates an isolated tab to the Google SERP for the query, parses the anchors and closes the tab", async () => {
    const fake = await searching();
    const { client, closed } = closing(fake);
    const r = await webSearchTool.handler({ query: "pi browser harness" }, handlerContext(client));
    assert.equal(r.success, true);
    assert.deepEqual(fake.calls.map((c) => [c.method, c.sessionId]), [
      ["Target.getTargets", null],
      ["Target.createTarget", null],
      ["Target.attachToTarget", null],
      ["Page.enable", "s-iso"],
      ["Page.navigate", "s-iso"],
      ["Runtime.evaluate", "s-iso"],
    ]);
    assert.equal(
      fake.callsTo("Page.navigate")[0]?.params["url"],
      "https://www.google.com/search?q=pi%20browser%20harness&num=10&hl=en",
    );
    assert.match(String(fake.callsTo("Runtime.evaluate")[0]?.params["expression"]), /^\(function extractSerp\(/);
    assert.deepEqual(closed, ["t2"]);

    const results = [
      { title: "First", url: "https://first.test/a", snippet: "one", rank: 1 },
      { title: "Second", url: "https://second.test/b", snippet: "two", rank: 2 },
      { title: "Third", url: "https://third.test/c", snippet: "three", rank: 3 },
    ];
    const body =
      '3 result(s) for "pi browser harness":\n\n' +
      "1. First\n   https://first.test/a\n   one\n\n" +
      "2. Second\n   https://second.test/b\n   two\n\n" +
      "3. Third\n   https://third.test/c\n   three";
    assert.equal(r.data.text, body);
    assert.deepEqual(r.data.details, {
      results,
      engine: "google",
      query: "pi browser harness",
      render: { summary: '3 result(s) · google · "pi browser harness"', body },
    });
  });

  test("limit is applied to the SERP url and to the parsed results", async () => {
    const fake = await searching();
    const r = await webSearchTool.handler({ query: "q", limit: 2 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(fake.callsTo("Page.navigate")[0]?.params["url"], "https://www.google.com/search?q=q&num=2&hl=en");
    assert.equal(r.data.details?.results.length, 2);
    assert.match(r.data.text, /^2 result\(s\)/);
  });

  test("a CAPTCHA page is invalid_state with reason captcha and the SERP url", async () => {
    const wall: SerpExtraction = { anchors: [], pageText: "Our systems have detected unusual traffic from your network" };
    const fake = await searching({ "Runtime.evaluate": evaluated(JSON.stringify(wall)) });
    const { client, closed } = closing(fake);
    const r = await webSearchTool.handler({ query: "x y", engine: "google" }, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.equal(r.error.message, "Google served a CAPTCHA / bot wall");
    assert.deepEqual(r.error.details, {
      reason: "captcha",
      serpUrl: "https://www.google.com/search?q=x%20y&num=10&hl=en",
      engine: "google",
    });
    assert.deepEqual(closed, ["t2"]);
  });

  test("a page with only Google-internal anchors is invalid_state with reason extraction_mismatch and the anchor count", async () => {
    const empty: SerpExtraction = {
      anchors: [{ href: "https://accounts.google.com/", heading: "Sign in", snippet: "" }],
      pageText: "Your search did not match any documents",
    };
    const fake = await searching({ "Runtime.evaluate": evaluated(JSON.stringify(empty)) });
    const r = await webSearchTool.handler({ query: "zzz", engine: "google" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.equal(r.error.message, "found 1 result anchor(s) but none parsed to an external url (Google markup may have changed)");
    assert.deepEqual(r.error.details, {
      reason: "extraction_mismatch",
      anchorCount: 1,
      serpUrl: "https://www.google.com/search?q=zzz&num=10&hl=en",
      engine: "google",
    });
  });

  test("a page with no anchors at all is invalid_state with reason no_results", async () => {
    const empty: SerpExtraction = { anchors: [], pageText: "Your search did not match any documents" };
    const fake = await searching({ "Runtime.evaluate": evaluated(JSON.stringify(empty)) });
    const r = await webSearchTool.handler({ query: "zzz", engine: "google" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.equal(r.error.message, "no results found");
    assert.deepEqual(r.error.details, {
      reason: "no_results",
      serpUrl: "https://www.google.com/search?q=zzz&num=10&hl=en",
      engine: "google",
    });
  });

  test("/goto anchors are resolved through the redirect resolver, and the cite is the fallback", async () => {
    const goto: SerpExtraction = {
      anchors: [
        { href: "https://www.google.com/goto?url=CAESWgHr", heading: "TS", snippet: "s1", cite: "https://www.typescriptlang.org" },
        { href: "https://www.google.com/goto?url=CAESdAHr", heading: "W3", snippet: "s2", cite: "https://www.w3schools.com › typescript_intro" },
        { href: "https://www.google.com/goto?url=CAESYwHr", heading: "Wiki", snippet: "s3", cite: "https://en.wikipedia.org › wiki › TypeScript" },
      ],
      pageText: "results",
    };
    const asked: string[] = [];
    const tool = createWebSearchTool({
      engines: defaultEngines(),
      resolveRedirect: (href) => {
        asked.push(href);
        if (href.includes("CAESdAHr")) return Promise.resolve("https://www.w3schools.com/typescript/typescript_intro.php");
        if (href.includes("CAESWgHr")) return Promise.resolve("https://www.typescriptlang.org/");
        return Promise.resolve(undefined);
      },
    });
    const fake = await searching({ "Runtime.evaluate": evaluated(JSON.stringify(goto)) });
    const r = await tool.handler({ query: "typescript", limit: 3 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(asked.sort(), goto.anchors.map((a) => a.href).sort());
    assert.deepEqual(r.data.details?.results, [
      { title: "TS", url: "https://www.typescriptlang.org/", snippet: "s1", rank: 1 },
      { title: "W3", url: "https://www.w3schools.com/typescript/typescript_intro.php", snippet: "s2", rank: 2 },
      { title: "Wiki", url: "https://en.wikipedia.org/wiki/TypeScript", snippet: "s3", rank: 3 },
    ]);
  });

  test("only /goto anchors are sent to the resolver; direct and /url?q= hrefs never are", async () => {
    const asked: string[] = [];
    const tool = createWebSearchTool({ engines: defaultEngines(), resolveRedirect: (href) => { asked.push(href); return Promise.resolve(undefined); } });
    const fake = await searching();
    const r = await tool.handler({ query: "q" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(asked, []);
  });

  test("a resolver that throws or hangs past the budget still yields cite-based results", async () => {
    const goto: SerpExtraction = {
      anchors: [
        { href: "https://www.google.com/goto?url=A", heading: "A", snippet: "", cite: "https://a.example › x" },
        { href: "https://www.google.com/goto?url=B", heading: "B", snippet: "", cite: "https://b.example" },
      ],
      pageText: "results",
    };
    const tool = createWebSearchTool({
      engines: defaultEngines(),
      resolveRedirect: (href) => (href.endsWith("A") ? Promise.reject(new Error("boom")) : new Promise(() => undefined)),
      resolveBudgetMs: 50,
    });
    const fake = await searching({ "Runtime.evaluate": evaluated(JSON.stringify(goto)) });
    const r = await tool.handler({ query: "q" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(r.data.details?.results.map((x) => x.url), ["https://a.example/x", "https://b.example"]);
  });

  test("an extraction of the wrong shape is an internal error that names the mismatch", async () => {
    const fake = await searching({ "Runtime.evaluate": evaluated(JSON.stringify({ anchors: "nope" })) });
    const { client, closed } = closing(fake);
    const r = await webSearchTool.handler({ query: "q", engine: "google" }, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "internal");
    assert.match(r.error.message, /^SERP extraction returned an unexpected shape: /);
    assert.deepEqual(closed, ["t2"]);
  });

  test("an extraction that is not JSON text is a cdp_error from Runtime.evaluate", async () => {
    const fake = await searching({ "Runtime.evaluate": evaluated(7) });
    const r = await webSearchTool.handler({ query: "q", engine: "google" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "Runtime.evaluate", engine: "google" });
  });

  test("a navigation failure closes the tab", async () => {
    const fake = await searching({ "Page.navigate": err(cdpError("timeout", "slow")) });
    const { client, closed } = closing(fake);
    const r = await webSearchTool.handler({ query: "q", engine: "google" }, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.deepEqual(closed, ["t2"]);
  });

  test("an aborted load is a timeout and the tab is closed", async () => {
    const ac = new AbortController();
    const fake = await createFakeClient({
      canned: {
        "Target.createTarget": ok({ targetId: "t2" }),
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-iso" })],
        "Page.navigate": ok({ frameId: "f" }),
      },
      evaluate: () => {
        ac.abort();
        return ok(false);
      },
    });
    const { client, closed } = closing(fake);
    const r = await webSearchTool.handler({ query: "q" }, handlerContext(client, ac.signal));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.deepEqual(closed, ["t2"]);
    assert.equal(fake.callsTo("Runtime.evaluate").length, 0);
  });

  test("when the isolated tab cannot be opened nothing is navigated or closed", async () => {
    const fake = await searching({ "Target.createTarget": err(cdpError("remote_error", "blocked")) });
    const { client, closed } = closing(fake);
    const r = await webSearchTool.handler({ query: "q" }, handlerContext(client));
    assert.equal(r.success, false);
    assert.deepEqual(r.error.details, { method: "Target.createTarget" });
    assert.deepEqual(closed, []);
    assert.equal(fake.callsTo("Page.navigate").length, 0);
  });
});

const fakeEngine = (id: string): SearchEngine => ({
  id,
  name: id.toUpperCase(),
  buildUrl: (query) => `https://${id}.test/search?q=${encodeURIComponent(query)}`,
  selectors: { root: "#r", heading: "h3", containers: ["div"], cite: "cite" },
  captchaMarkers: ["bot wall"],
  resultUrl: (anchor) => (anchor.href.includes(".test/search") ? undefined : anchor.href),
});

const WALL: SerpExtraction = { anchors: [], pageText: "a bot wall" };
const EMPTY: SerpExtraction = { anchors: [], pageText: "nothing" };
const HIT: SerpExtraction = { anchors: [{ href: "https://hit.example/", heading: "Hit", snippet: "s" }], pageText: "" };

const ladderTool = createWebSearchTool({
  engines: createEngineRegistry().mount(fakeEngine("alpha")).mount(fakeEngine("beta")).mount(fakeEngine("gamma")),
  resolveRedirect: fetchRedirectTarget,
});

const pages = (...extractions: SerpExtraction[]): Promise<FakeClient> =>
  searching({ "Runtime.evaluate": extractions.map((e) => evaluated(JSON.stringify(e))) });

describe("browser_web_search fallback ladder", () => {
  test("walks the engines in mount order and answers from the first that returns results, in one tab", async () => {
    const fake = await pages(WALL, EMPTY, HIT);
    const { client, closed } = closing(fake);
    const r = await ladderTool.handler({ query: "q" }, handlerContext(client));
    assert.equal(r.success, true);
    const details = r.data.details;
    assert.ok(details);
    assert.deepEqual(fake.callsTo("Page.navigate").map((c) => c.params["url"]), [
      "https://alpha.test/search?q=q",
      "https://beta.test/search?q=q",
      "https://gamma.test/search?q=q",
    ]);
    assert.equal(fake.callsTo("Target.createTarget").length, 1);
    assert.deepEqual(closed, ["t2"]);
    assert.equal(details.engine, "gamma");
    assert.deepEqual(details.fallbacks, [
      { engine: "alpha", kind: "invalid_state", reason: "captcha", message: "ALPHA served a CAPTCHA / bot wall" },
      { engine: "beta", kind: "invalid_state", reason: "no_results", message: "no results found" },
    ]);
    assert.equal(details.render.summary, '1 result(s) · gamma (after alpha, beta failed) · "q"');
  });

  test("the first engine answering leaves no fallbacks and stops the ladder", async () => {
    const fake = await pages(HIT);
    const r = await ladderTool.handler({ query: "q" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    const details = r.data.details;
    assert.ok(details);
    assert.equal(details.engine, "alpha");
    assert.equal(details.fallbacks, undefined);
    assert.equal(fake.callsTo("Page.navigate").length, 1);
  });

  test("a navigation failure on one engine falls through to the next", async () => {
    const fake = await searching({
      "Page.navigate": [err(cdpError("timeout", "slow")), ok({ frameId: "f" })],
      "Runtime.evaluate": evaluated(JSON.stringify(HIT)),
    });
    const r = await ladderTool.handler({ query: "q" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    const details = r.data.details;
    assert.ok(details);
    assert.equal(details.engine, "beta");
    assert.equal(details.fallbacks?.[0]?.kind, "timeout");
  });

  test("a named engine is searched alone, with no fallback, and reports its own failure", async () => {
    const fake = await pages(WALL, HIT);
    const r = await ladderTool.handler({ query: "q", engine: "beta" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.deepEqual(fake.callsTo("Page.navigate").map((c) => c.params["url"]), ["https://beta.test/search?q=q"]);
    assert.deepEqual(r.error.details, { reason: "captcha", serpUrl: "https://beta.test/search?q=q", engine: "beta" });
  });

  test("an unknown engine is invalid_args naming the mounted engines, and no tab is opened", async () => {
    const fake = await pages(HIT);
    const r = await ladderTool.handler({ query: "q", engine: "altavista" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
    assert.equal(r.error.message, 'unknown search engine "altavista"; mounted engines: alpha, beta, gamma');
    assert.equal(fake.callsTo("Target.createTarget").length, 0);
  });

  test("when every engine fails it is all_engines_failed with each attempt", async () => {
    const fake = await pages(WALL, EMPTY, WALL);
    const { client, closed } = closing(fake);
    const r = await ladderTool.handler({ query: "q" }, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.equal(r.error.details?.["reason"], "all_engines_failed");
    const attempts = asArrayOf(r.error.details["attempts"], asRecord) ?? [];
    assert.deepEqual(attempts.map((a) => a["engine"]), ["alpha", "beta", "gamma"]);
    assert.deepEqual(closed, ["t2"]);
  });

  test("when every engine finds nothing it stays no_results, so the agent rephrases", async () => {
    const fake = await pages(EMPTY);
    const r = await ladderTool.handler({ query: "q" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.details?.["reason"], "no_results");
    assert.match(r.error.message, /^no results found on any engine/);
  });

  test("a cancelled call stops the ladder instead of trying the next engine", async () => {
    const ac = new AbortController();
    const fake = await createFakeClient({
      canned: {
        "Target.createTarget": ok({ targetId: "t2" }),
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-iso" })],
        "Page.navigate": ok({ frameId: "f" }),
      },
      evaluate: () => {
        ac.abort();
        return ok(false);
      },
    });
    const r = await ladderTool.handler({ query: "q" }, handlerContext(fake.client, ac.signal));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.equal(fake.callsTo("Page.navigate").length, 1);
  });

  test("an engine with a readySelector waits for rendered results before extracting", async () => {
    const polled: string[] = [];
    const fake = await createFakeClient({
      canned: {
        "Target.createTarget": ok({ targetId: "t2" }),
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-iso" })],
        "Page.navigate": ok({ frameId: "f" }),
        "Runtime.evaluate": evaluated(JSON.stringify(HIT)),
      },
      evaluate: (expression) => {
        if (expression.includes("querySelector(")) polled.push(expression);
        return ok(expression.includes("readyState") || polled.length >= 2 ? true : false);
      },
    });
    const tool = createWebSearchTool({
      engines: createEngineRegistry().mount({ ...fakeEngine("js"), readySelector: "article.result" }),
      resolveRedirect: fetchRedirectTarget,
    });
    const r = await tool.handler({ query: "q" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(polled.length, 2);
    assert.match(polled[0] ?? "", /document\.querySelector\("article\.result"\) !== null/);
  });

  test("the engine parameter and description are built from the mounted engines", () => {
    assert.deepEqual(asRecord(ladderTool.parameters.properties.engine)?.["enum"], ["alpha", "beta", "gamma"]);
    assert.match(ladderTool.description, /alpha → beta → gamma/);
    assert.match(webSearchTool.description, /google → bing → duckduckgo → brave/);
  });

  test("a tool with no mounted engines is a wiring error", () => {
    assert.throws(
      () => createWebSearchTool({ engines: createEngineRegistry(), resolveRedirect: fetchRedirectTarget }),
      /at least one mounted search engine/,
    );
  });
});

describe("parseSerpExtraction", () => {
  test("accepts the extraction shape", () => {
    assert.deepEqual(parseSerpExtraction(JSON.stringify(EXTRACTION)), { success: true, data: EXTRACTION });
  });

  test("rejects malformed JSON and missing fields with a message", () => {
    const bad = parseSerpExtraction("{");
    assert.equal(bad.success, false);
    assert.match(bad.error, /JSON parse failed/);
    const partial = parseSerpExtraction(JSON.stringify({ anchors: [] }));
    assert.equal(partial.success, false);
    assert.ok(partial.error.length > 0);
  });
});

describe("browser_web_search renderResult", () => {
  before(() => {
    installTheme();
  });

  test("renders the expandable summary", () => {
    const result = {
      content: [{ type: "text" as const, text: "ignored" }],
      details: {
        results: [],
        engine: "google" as const,
        query: "q",
        render: { summary: '0 result(s) · google · "q"', body: "nothing" },
      },
    };
    const text = renderedText(render(result, false));
    assert.match(text, /0 result\(s\) · google · "q"/);
    assert.match(text, /nothing/);
  });
});
