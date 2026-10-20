import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { type Canned, createFakeClient, type FakeClient, handlerContext } from "./fake-client";
import { installTheme, renderedText, testTheme, withClient } from "./client-overrides";
import type { Component } from "@mariozechner/pi-tui";
import { parseSerpExtraction, webSearchTool } from "../../src/domains/search/web-search";
import type { SerpExtraction } from "../../src/domains/search/google-serp";
import { cdpError } from "../../src/cdp/errors";
import { err, ok } from "../../src/util/result";

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

const evaluated = (value: unknown) => ok({ result: { type: typeof value, value } });

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

const render = (result: Parameters<NonNullable<typeof webSearchTool.renderResult>>[0], expanded: boolean): Component => {
  assert.ok(webSearchTool.renderResult);
  return webSearchTool.renderResult(result, expanded, testTheme);
};

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
    const r = await webSearchTool.handler({ query: "x y" }, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.equal(r.error.message, "Google served a CAPTCHA / bot wall");
    assert.deepEqual(r.error.details, { reason: "captcha", serpUrl: "https://www.google.com/search?q=x%20y&num=10&hl=en" });
    assert.deepEqual(closed, ["t2"]);
  });

  test("a page with only Google-internal anchors is invalid_state with reason no_results", async () => {
    const empty: SerpExtraction = {
      anchors: [{ href: "https://accounts.google.com/", heading: "Sign in", snippet: "" }],
      pageText: "Your search did not match any documents",
    };
    const fake = await searching({ "Runtime.evaluate": evaluated(JSON.stringify(empty)) });
    const r = await webSearchTool.handler({ query: "zzz" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.equal(r.error.message, "no results found");
    assert.equal(r.error.details?.["reason"], "no_results");
  });

  test("an extraction of the wrong shape is an internal error that names the mismatch", async () => {
    const fake = await searching({ "Runtime.evaluate": evaluated(JSON.stringify({ anchors: "nope" })) });
    const { client, closed } = closing(fake);
    const r = await webSearchTool.handler({ query: "q" }, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "internal");
    assert.match(r.error.message, /^SERP extraction returned an unexpected shape: /);
    assert.deepEqual(closed, ["t2"]);
  });

  test("an extraction that is not JSON text is a cdp_error from Runtime.evaluate", async () => {
    const fake = await searching({ "Runtime.evaluate": evaluated(7) });
    const r = await webSearchTool.handler({ query: "q" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "Runtime.evaluate" });
  });

  test("a navigation failure closes the tab", async () => {
    const fake = await searching({ "Page.navigate": err(cdpError("timeout", "slow")) });
    const { client, closed } = closing(fake);
    const r = await webSearchTool.handler({ query: "q" }, handlerContext(client));
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
