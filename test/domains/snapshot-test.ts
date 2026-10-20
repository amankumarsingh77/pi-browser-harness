import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { axNode, type Canned, createFakeClient, type FakeClient, handlerContext } from "./fake-client";
import { alwaysPageInfo, dialogOf, installTheme, pageInfoError, pageInfoOf, pngOf, renderWith, renderedText, withClient } from "./client-overrides";
import { snapshotTool, type SnapshotDetails } from "../../src/domains/snapshot";
import type { BrowserClient } from "../../src/client";
import type { CdpSession } from "../../src/cdp/session";
import { cdpError } from "../../src/cdp/errors";
import { asRecord } from "../../src/util/guards";
import { err, ok } from "../../src/util/result";

// RootWebArea
//   button "Go"            (backend 10)
//   textbox "Email"        (backend 11, AX value "stale")
//   generic (ignored)      → hoisted
//     link "Docs"          (backend 12)
//   StaticText "hello"     (no backend id)
const TREE = ok({
  nodes: [
    axNode("1", "RootWebArea", "Page", { childIds: ["2", "3", "4", "6"] }),
    axNode("2", "button", "Go", { parentId: "1", backendDOMNodeId: 10 }),
    axNode("3", "textbox", "Email", { parentId: "1", backendDOMNodeId: 11, value: { value: "stale" } }),
    axNode("4", "generic", "", { parentId: "1", ignored: true, childIds: ["5"] }),
    axNode("5", "link", "Docs", { parentId: "4", backendDOMNodeId: 12 }),
    axNode("6", "StaticText", "hello", { parentId: "1" }),
  ],
});

const BOX = ok({ model: { content: [10, 20, 110, 20, 110, 70, 10, 70], width: 100, height: 50 } });
const LIVE = {
  "DOM.resolveNode": ok({ object: { type: "object", objectId: "obj-11" } }),
  "Runtime.callFunctionOn": ok({ result: { type: "string", value: "typed" } }),
};

const produced: string[] = [];
after(async () => {
  await Promise.all(produced.map((p) => rm(p, { force: true })));
});

const snapshotting = async (canned: Canned = {}): Promise<{ fake: FakeClient; client: BrowserClient }> => {
  const fake = await createFakeClient({ canned: { "Accessibility.getFullAXTree": TREE, "DOM.getBoxModel": BOX, ...LIVE, ...canned } });
  const client = withClient(fake.client, { pageInfo: alwaysPageInfo(pageInfoOf()) });
  return { fake, client };
};

const details = (d: SnapshotDetails | undefined): SnapshotDetails => {
  assert.ok(d);
  return d;
};

const render = renderWith(snapshotTool);

describe("browser_snapshot outline", () => {
  test("renders refs, click coordinates and live values for interactive nodes, hoisting ignored wrappers", async () => {
    const { fake, client } = await snapshotting();
    const r = await snapshotTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.equal(
      r.data.text,
      [
        '- RootWebArea "Page"',
        '  - button "Go" [e1] @(60,45)',
        '  - textbox "Email" = "typed" [e2] @(60,45)',
        '  - link "Docs" [e3] @(60,45)',
        '  - StaticText "hello"',
      ].join("\n"),
    );
    assert.deepEqual(details(r.data.details), {
      nodeCount: 5,
      truncated: false,
      url: "https://example.test/page",
      title: "Example",
      summary: "1 button · 1 input · 1 link",
    });
    assert.equal(fake.callsTo("Accessibility.getFullAXTree")[0]?.sessionId, "s1");
    assert.deepEqual(fake.callsTo("DOM.getBoxModel").map((c) => c.params["backendNodeId"]), [10, 11, 12]);
    // Only value-bearing roles read the live DOM value.
    assert.deepEqual(fake.callsTo("DOM.resolveNode").map((c) => c.params["backendNodeId"]), [11]);
    assert.equal(fake.callsTo("Page.captureScreenshot").length, 0);
  });

  test("publishes the refs and their signatures on the session", async () => {
    const { fake, client } = await snapshotting();
    const r = await snapshotTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.deepEqual([...fake.session.refMappings()], [["e1", 10], ["e2", 11], ["e3", 12]]);
    assert.deepEqual(fake.session.refSignatures().get("e2"), { role: "textbox", name: "Email", value: "typed", state: "" });
  });

  test("a box that cannot be measured drops the coordinates but keeps the ref", async () => {
    const { client } = await snapshotting({ "DOM.getBoxModel": err(cdpError("remote_error", "Could not compute box model")) });
    const r = await snapshotTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /- button "Go" \[e1\]$/m);
    assert.doesNotMatch(r.data.text, /@\(/);
  });

  test("an off-screen (negative) box is omitted", async () => {
    const { client } = await snapshotting({
      "DOM.getBoxModel": ok({ model: { content: [-5, 20, 95, 20, 95, 70, -5, 70], width: 100, height: 50 } }),
    });
    const r = await snapshotTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.doesNotMatch(r.data.text, /@\(/);
  });

  test("a live value of the wrong type leaves the AX value in place", async () => {
    const { client } = await snapshotting({ "Runtime.callFunctionOn": ok({ result: { type: "number", value: 3 } }) });
    const r = await snapshotTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /textbox "Email" = "stale"/);
  });

  test("an aborted signal skips the geometry pass but still returns the tree and refs", async () => {
    const ac = new AbortController();
    ac.abort();
    const { fake, client } = await snapshotting();
    const r = await snapshotTool.handler({}, handlerContext(client, ac.signal));
    assert.equal(r.success, true);
    assert.equal(fake.callsTo("DOM.getBoxModel").length, 0);
    assert.match(r.data.text, /\[e1\]/);
    assert.doesNotMatch(r.data.text, /@\(/);
    assert.equal(fake.session.resolveRef("e1"), 10);
  });
});

describe("browser_snapshot box enrichment runs under the concurrency limit", () => {
  const manyButtons = (n: number) =>
    ok({
      nodes: [
        axNode("root", "RootWebArea", "", { childIds: Array.from({ length: n }, (_, i) => `b${i}`) }),
        ...Array.from({ length: n }, (_, i) => axNode(`b${i}`, "button", `B${i}`, { parentId: "root", backendDOMNodeId: 100 + i })),
      ],
    });

  test("never has more than eight box lookups in flight and measures every target", async () => {
    const fake = await createFakeClient({ canned: { "Accessibility.getFullAXTree": manyButtons(30), "DOM.getBoxModel": BOX } });
    let inFlight = 0;
    let peak = 0;
    const inner = fake.session;
    const slowSession: CdpSession = {
      ...inner,
      call: async (method, ...args) => {
        if (method !== "DOM.getBoxModel") return inner.call(method, ...args);
        inFlight++;
        peak = Math.max(peak, inFlight);
        await new Promise((resolve) => setTimeout(resolve, 2));
        inFlight--;
        return inner.call(method, ...args);
      },
    };
    const client = withClient(fake.client, { pageInfo: alwaysPageInfo(pageInfoOf()), session: () => slowSession });
    const r = await snapshotTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.equal(peak, 8);
    assert.equal(fake.callsTo("DOM.getBoxModel").length, 30);
    assert.equal((r.data.text.match(/@\(60,45\)/g) ?? []).length, 30);
    assert.equal(details(r.data.details).summary, "30 buttons");
  });
});

describe("browser_snapshot filtering and formats", () => {
  test("interestingOnly:false keeps ignored wrappers as nodes", async () => {
    const { client } = await snapshotting();
    const r = await snapshotTool.handler({ interestingOnly: false }, handlerContext(client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /^ {2}- generic\n {4}- link "Docs" \[e3\]/m);
    assert.equal(details(r.data.details).nodeCount, 6);
  });

  test("maxNodes caps the slim tree in document order", async () => {
    const { client } = await snapshotting();
    const r = await snapshotTool.handler({ maxNodes: 2 }, handlerContext(client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, '- RootWebArea "Page"\n  - button "Go" [e1] @(60,45)');
    assert.equal(details(r.data.details).nodeCount, 2);
    assert.equal(details(r.data.details).truncated, false);
  });

  test("format:'json' returns the slim structure with refs and boxes but no backend ids", async () => {
    const { client } = await snapshotting();
    const r = await snapshotTool.handler({ format: "json" }, handlerContext(client));
    assert.equal(r.success, true);
    assert.doesNotMatch(r.data.text, /_backendId/);
    const parsed: unknown = JSON.parse(r.data.text);
    assert.ok(Array.isArray(parsed));
    const root = asRecord(parsed[0]);
    assert.ok(root);
    assert.equal(root["role"], "RootWebArea");
    const children = root["children"];
    assert.ok(Array.isArray(children));
    const button = asRecord(children[0]);
    assert.ok(button);
    assert.equal(button["ref"], "e1");
    assert.deepEqual(button["box"], { x: 10, y: 20, width: 100, height: 50, cx: 60, cy: 45 });
  });

  test("an open dialog leaves url and title empty rather than failing", async () => {
    const fake = await createFakeClient({ canned: { "Accessibility.getFullAXTree": TREE, "DOM.getBoxModel": BOX } });
    const client = withClient(fake.client, { pageInfo: alwaysPageInfo(dialogOf({ type: "alert", message: "!" })) });
    const r = await snapshotTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.equal(details(r.data.details).url, "");
    assert.equal(details(r.data.details).title, "");
  });

  test("an empty tree yields no nodes, no refs and an empty summary", async () => {
    const { fake, client } = await snapshotting({ "Accessibility.getFullAXTree": ok({ nodes: [] }) });
    const r = await snapshotTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "");
    assert.deepEqual(details(r.data.details), { nodeCount: 0, truncated: false, url: "https://example.test/page", title: "Example", summary: "" });
    assert.equal(fake.callsTo("DOM.getBoxModel").length, 0);
  });
});

describe("browser_snapshot errors", () => {
  test("an AX tree failure is a cdp_error naming the method, before page info is read", async () => {
    const fake = await createFakeClient({ canned: { "Accessibility.getFullAXTree": err(cdpError("timeout", "slow tree")) } });
    let infoReads = 0;
    const client = withClient(fake.client, {
      pageInfo: () => {
        infoReads++;
        return Promise.resolve(pageInfoOf());
      },
    });
    const r = await snapshotTool.handler({}, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.deepEqual(r.error.details, { method: "Accessibility.getFullAXTree" });
    assert.equal(infoReads, 0);
  });

  test("a page-info failure is propagated", async () => {
    const fake = await createFakeClient({ canned: { "Accessibility.getFullAXTree": TREE } });
    const client = withClient(fake.client, { pageInfo: alwaysPageInfo(pageInfoError("remote_error", "ctx gone", "Runtime.evaluate")) });
    const r = await snapshotTool.handler({}, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "Runtime.evaluate" });
  });
});

describe("browser_snapshot includeScreenshot", () => {
  const PNG = pngOf(1, 1);

  test("captures a jpeg at quality 80 and records its path", async () => {
    const { fake, client } = await snapshotting({ "Page.captureScreenshot": ok({ data: PNG.toString("base64") }) });
    const r = await snapshotTool.handler({ includeScreenshot: true }, handlerContext(client));
    assert.equal(r.success, true);
    const path = details(r.data.details).screenshotPath;
    assert.ok(path);
    produced.push(path);
    assert.match(path, /\.jpeg$/);
    assert.deepEqual(fake.callsTo("Page.captureScreenshot").map((c) => c.params), [{ format: "jpeg", quality: 80 }]);
    assert.deepEqual(await readFile(path), PNG);
  });

  test("a capture failure drops the screenshot but the snapshot still succeeds", async () => {
    const { client } = await snapshotting({ "Page.captureScreenshot": err(cdpError("remote_error", "no surface")) });
    const r = await snapshotTool.handler({ includeScreenshot: true }, handlerContext(client));
    assert.equal(r.success, true);
    assert.equal("screenshotPath" in details(r.data.details), false);
  });
});

describe("browser_snapshot renderResult", () => {
  before(() => {
    installTheme();
  });

  const stored = (d: SnapshotDetails, text: string) => ({ content: [{ type: "text" as const, text }], details: d });
  const BASE: SnapshotDetails = { nodeCount: 5, truncated: false, url: "https://example.test/page", title: "Example", summary: "1 button" };

  test("collapsed shows the node count, url, title, summary and screenshot status", () => {
    const text = renderedText(render(stored(BASE, "TREEBODY"), false));
    assert.match(text, /AX tree: 5 nodes/);
    assert.match(text, /example\.test\/page/);
    assert.match(text, /"Example"/);
    assert.match(text, /• 1 button/);
    assert.match(text, /screenshot omitted/);
    assert.doesNotMatch(text, /TREEBODY/);
  });

  test("expanded shows the tree text and the full-output path when truncated", () => {
    const d: SnapshotDetails = { ...BASE, truncated: true, fullOutputPath: "/tmp/pi-bh-snapshot/output.txt" };
    const text = renderedText(render(stored(d, '- button "Go" [e1]'), true));
    assert.match(text, /- button "Go" \[e1\]/);
    assert.match(text, /Full tree at .*output\.txt/);
    assert.match(text, /to collapse/);
  });

  test("an empty url and title render as (no url) with no title line", () => {
    const text = renderedText(render(stored({ ...BASE, url: "", title: "" }, ""), false));
    assert.match(text, /\(no url\)/);
    assert.doesNotMatch(text, /""/);
  });

  test("a screenshot path that no longer exists still renders the tree", () => {
    const d: SnapshotDetails = { ...BASE, screenshotPath: join(tmpdir(), `bh-snap-missing-${process.pid}.jpeg`) };
    const text = renderedText(render(stored(d, "tree body"), true));
    assert.match(text, /tree body/);
  });
});
