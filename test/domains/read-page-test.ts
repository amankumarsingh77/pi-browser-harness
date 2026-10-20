import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { type Canned, createFakeClient, type FakeClient, handlerContext } from "./fake-client";
import { installTheme, renderedText, testTheme, withClient } from "./client-overrides";
import { type ReadPageDetails, readPageTool, toPageCapture } from "../../src/domains/readpage/read-page";
import type { Component } from "@mariozechner/pi-tui";
import type { PageCapture } from "../../src/domains/readpage/readability";
import { cdpError } from "../../src/cdp/errors";
import { err, ok } from "../../src/util/result";

const WORDS = Array.from({ length: 50 }, (_, i) => `word${i}`).join(" ");

const CAPTURE: PageCapture = {
  url: "https://example.test/article",
  title: "  An Article ",
  blocks: [
    { kind: "heading", text: "Intro", linkTextLength: 0, inBoilerplate: false },
    { kind: "paragraph", text: WORDS, linkTextLength: 0, inBoilerplate: false },
    { kind: "paragraph", text: "Nav link soup that is mostly links here", linkTextLength: 30, inBoilerplate: false },
    { kind: "listitem", text: "footer item", linkTextLength: 0, inBoilerplate: true },
  ],
  bodyText: "fallback body",
};

const evaluated = (value: unknown) => ok({ result: { type: typeof value, value } });

// The fake attaches t1 as s1; the isolated tab t2 receives the second attach result.
const reading = (canned: Canned = {}, readyState = true): Promise<FakeClient> =>
  createFakeClient({
    canned: {
      "Target.createTarget": ok({ targetId: "t2" }),
      "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-iso" })],
      "Page.navigate": ok({ frameId: "f" }),
      "Runtime.evaluate": evaluated(JSON.stringify(CAPTURE)),
      ...canned,
    },
    evaluate: (expression) => ok(expression.includes("readyState") ? readyState : undefined),
  });

const details = (d: ReadPageDetails | undefined): ReadPageDetails => {
  assert.ok(d, "a successful read carries details");
  return d;
};

const render = (result: Parameters<NonNullable<typeof readPageTool.renderResult>>[0], expanded: boolean): Component => {
  assert.ok(readPageTool.renderResult);
  return readPageTool.renderResult(result, expanded, testTheme);
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

describe("browser_read_page by url", () => {
  test("opens an isolated tab, navigates, waits for load, captures, and closes the tab", async () => {
    const fake = await reading();
    const { client, closed } = closing(fake);
    const r = await readPageTool.handler({ url: "https://example.test/article" }, handlerContext(client));
    assert.equal(r.success, true);
    assert.deepEqual(fake.calls.map((c) => [c.method, c.sessionId]), [
      ["Target.getTargets", null],
      ["Target.createTarget", null],
      ["Target.attachToTarget", null],
      ["Page.enable", "s-iso"],
      ["Page.navigate", "s-iso"],
      ["Runtime.evaluate", "s-iso"],
    ]);
    assert.equal(fake.callsTo("Page.navigate")[0]?.params["url"], "https://example.test/article");
    assert.deepEqual(closed, ["t2"]);
    assert.ok(fake.evaluated[0]?.includes("readyState"), "the load poll ran on the isolated tab");
    const expr = fake.callsTo("Runtime.evaluate")[0]?.params["expression"];
    assert.equal(typeof expr, "string");
    assert.match(String(expr), /^\(function capturePage\(/);

    assert.equal(r.data.text.startsWith("# An Article\nhttps://example.test/article\n(52 words)\n\n"), true, r.data.text);
    assert.match(r.data.text, /\n## Intro\n/);
    assert.match(r.data.text, /word49/);
    assert.doesNotMatch(r.data.text, /link soup/);
    assert.doesNotMatch(r.data.text, /footer item/);
    const d = details(r.data.details);
    assert.deepEqual(d, {
      title: "An Article",
      url: "https://example.test/article",
      wordCount: 52,
      render: { summary: "An Article · 52 words", body: d.render.body },
    });
    assert.equal(d.render.body.includes("word0"), true);
  });

  test("a structure-less page falls back to the bounded body text", async () => {
    const thin: PageCapture = { ...CAPTURE, blocks: [{ kind: "paragraph", text: "too short", linkTextLength: 0, inBoilerplate: false }] };
    const fake = await reading({ "Runtime.evaluate": evaluated(JSON.stringify(thin)) });
    const r = await readPageTool.handler({ url: "https://example.test/thin" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(details(r.data.details).wordCount, 2);
    assert.match(r.data.text, /\n\nfallback body$/);
  });

  test("a navigation failure closes the tab and names Page.navigate", async () => {
    const fake = await reading({ "Page.navigate": err(cdpError("remote_error", "net::ERR_ABORTED")) });
    const { client, closed } = closing(fake);
    const r = await readPageTool.handler({ url: "https://example.test/x" }, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "Page.navigate" });
    assert.deepEqual(closed, ["t2"]);
    assert.equal(fake.callsTo("Runtime.evaluate").length, 0);
  });

  test("a load that is aborted is a timeout and the tab is still closed", async () => {
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
    const r = await readPageTool.handler({ url: "https://example.test/x" }, handlerContext(client, ac.signal));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.match(r.error.message, /page load/);
    assert.deepEqual(closed, ["t2"]);
  });

  test("a capture that is not JSON text is a cdp_error from Runtime.evaluate", async () => {
    const fake = await reading({ "Runtime.evaluate": evaluated(42) });
    const { client, closed } = closing(fake);
    const r = await readPageTool.handler({ url: "https://example.test/x" }, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "Runtime.evaluate" });
    assert.deepEqual(closed, ["t2"]);
  });

  test("a capture of the wrong shape is an internal error", async () => {
    const fake = await reading({ "Runtime.evaluate": evaluated(JSON.stringify({ url: "x", title: "y" })) });
    const { client, closed } = closing(fake);
    const r = await readPageTool.handler({ url: "https://example.test/x" }, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "internal");
    assert.equal(r.error.message, "page capture returned an unexpected shape");
    assert.deepEqual(closed, ["t2"]);
  });

  test("when the isolated tab cannot be opened nothing is closed", async () => {
    const fake = await reading({ "Target.createTarget": err(cdpError("remote_error", "blocked")) });
    const { client, closed } = closing(fake);
    const r = await readPageTool.handler({ url: "https://example.test/x" }, handlerContext(client));
    assert.equal(r.success, false);
    assert.deepEqual(r.error.details, { method: "Target.createTarget" });
    assert.deepEqual(closed, []);
  });
});

describe("browser_read_page by targetId", () => {
  test("attaches a flat session to the owned tab, evaluates there, and detaches", async () => {
    const fake = await createFakeClient({
      canned: { "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-read" })] },
      evaluate: () => ok(CAPTURE),
    });
    const seen: Array<string | undefined> = [];
    const client = withClient(fake.client, {
      evaluateJs: (expression, sessionId) => {
        seen.push(sessionId);
        return fake.client.evaluateJs(expression, sessionId);
      },
    });
    const r = await readPageTool.handler({ targetId: "t1" }, handlerContext(client));
    assert.equal(r.success, true);
    assert.deepEqual(fake.calls.map((c) => [c.method, c.params, c.sessionId]), [
      ["Target.attachToTarget", { targetId: "t1", flatten: true }, null],
      ["Target.detachFromTarget", { sessionId: "s-read" }, null],
    ]);
    assert.deepEqual(seen, ["s-read"]);
    assert.equal(details(r.data.details).title, "An Article");
    assert.equal(details(r.data.details).wordCount, 52);
  });

  test("an unowned tab is invalid_state without any CDP traffic", async () => {
    const fake = await createFakeClient();
    const r = await readPageTool.handler({ targetId: "zz" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.equal(r.error.message, "Tab zz is not owned by this session.");
    assert.equal(fake.calls.length, 0);
  });

  test("an attach failure is a cdp_error naming Target.attachToTarget", async () => {
    const fake = await createFakeClient({
      canned: { "Target.attachToTarget": [ok({ sessionId: "s1" }), err(cdpError("timeout", "no attach"))] },
    });
    const r = await readPageTool.handler({ targetId: "t1" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.deepEqual(r.error.details, { method: "Target.attachToTarget" });
    assert.equal(fake.callsTo("Target.detachFromTarget").length, 0);
  });

  test("a decoded capture of the wrong shape is an internal error and still detaches", async () => {
    const fake = await createFakeClient({
      canned: { "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-read" })] },
      evaluate: () => ok({ nope: true }),
    });
    const r = await readPageTool.handler({ targetId: "t1" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "internal");
    assert.equal(fake.callsTo("Target.detachFromTarget").length, 1);
  });

  test("empty url and targetId strings are invalid_args", async () => {
    const fake = await createFakeClient();
    const r = await readPageTool.handler({ url: "", targetId: "" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
  });

  test("url wins over targetId when both are given", async () => {
    const fake = await reading();
    const r = await readPageTool.handler({ url: "https://example.test/article", targetId: "t1" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(fake.callsTo("Target.createTarget").length, 1);
  });
});

describe("toPageCapture", () => {
  test("accepts JSON text and decoded objects of the capture shape", () => {
    assert.deepEqual(toPageCapture(JSON.stringify(CAPTURE)), CAPTURE);
    assert.deepEqual(toPageCapture(CAPTURE), CAPTURE);
  });

  test("rejects malformed JSON, the wrong shape, and non-object values", () => {
    assert.equal(toPageCapture("{not json"), undefined);
    assert.equal(toPageCapture(JSON.stringify({ url: "x" })), undefined);
    assert.equal(toPageCapture({ ...CAPTURE, blocks: [{ kind: "table", text: "", linkTextLength: 0, inBoilerplate: false }] }), undefined);
    assert.equal(toPageCapture(42), undefined);
    assert.equal(toPageCapture(null), undefined);
  });
});

describe("browser_read_page renderResult", () => {
  before(() => {
    installTheme();
  });

  test("renders the expandable summary and body", () => {
    const result = {
      content: [{ type: "text" as const, text: "ignored" }],
      details: { title: "T", url: "u", wordCount: 3, render: { summary: "T · 3 words", body: "one two three" } },
    };
    const collapsed = renderedText(render(result, false));
    assert.match(collapsed, /T · 3 words/);
    assert.match(collapsed, /one two three/);
    assert.match(collapsed, /to expand/);
    assert.match(renderedText(render(result, true)), /to collapse/);
  });
});
