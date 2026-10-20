import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { type Canned, createFakeClient, type FakeClient, handlerContext } from "./fake-client";
import { alwaysPageInfo, dialogOf, pageInfoError, pageInfoOf, withClient } from "./client-overrides";
import { navigateTool, openUrlsTool } from "../../src/domains/navigate";
import type { BrowserClient } from "../../src/client";
import type { TabInfo } from "../../src/cdp/types";
import { cdpError } from "../../src/cdp/errors";
import type { HandlerContext } from "../../src/util/tool";
import { asRecord } from "../../src/util/guards";
import { err, ok } from "../../src/util/result";

const URL = "https://example.test/next";
const ONE_TAB: ReadonlyArray<TabInfo> = [{ targetId: "t1", title: "Fake", url: "https://example.test/", owned: true }];

describe("browser_navigate", () => {
  const navigating = async (
    canned: Canned,
    overrides: Partial<BrowserClient> = {},
  ): Promise<{ fake: FakeClient; client: BrowserClient }> => {
    const fake = await createFakeClient({ canned });
    const client = withClient(fake.client, {
      listTabs: () => Promise.resolve(ok(ONE_TAB)),
      pageInfo: alwaysPageInfo(pageInfoOf({ url: URL, title: "Next" })),
      ...overrides,
    });
    return { fake, client };
  };

  test("with a tab open it navigates the current session in place", async () => {
    const { fake, client } = await navigating({ "Page.navigate": ok({ frameId: "f1" }) });
    const r = await navigateTool.handler({ url: URL }, handlerContext(client));
    assert.equal(r.success, true);
    assert.deepEqual(fake.calls.map((c) => [c.method, c.params, c.sessionId]), [["Page.navigate", { url: URL }, "s1"]]);
    assert.equal(r.data.text, `Navigated to: ${URL}\nTitle: Next\nViewport: 1000x600\nTarget: t1`);
    assert.deepEqual(r.data.details, {
      outcome: { kind: "in_place", targetId: "t1" },
      page: { kind: "page", url: URL, title: "Next", width: 1000, height: 600, scrollX: 0, scrollY: 120, pageWidth: 1000, pageHeight: 4000 },
    });
  });

  test("with no tabs it opens a new one via the client instead of Page.navigate", async () => {
    const asked: Array<string | undefined> = [];
    const { fake, client } = await navigating({}, {
      listTabs: () => Promise.resolve(ok([])),
      newTab: (url) => {
        asked.push(url);
        return Promise.resolve(ok("t5"));
      },
    });
    const r = await navigateTool.handler({ url: URL }, handlerContext(client));
    assert.equal(r.success, true);
    assert.deepEqual(asked, [URL]);
    assert.equal(fake.callsTo("Page.navigate").length, 0);
    assert.match(r.data.text, /^New tab: Navigated to: /);
    assert.match(r.data.text, /Target: t5$/);
    assert.deepEqual(asRecord(r.data.details?.["outcome"]), { kind: "new_tab_created", targetId: "t5", reason: "no_tabs" });
  });

  test("chrome:// tabs are excluded when deciding whether any tab exists", async () => {
    const seen: Array<boolean | undefined> = [];
    const { client } = await navigating({ "Page.navigate": ok({ frameId: "f1" }) }, {
      listTabs: (includeInternal) => {
        seen.push(includeInternal);
        return Promise.resolve(ok(ONE_TAB));
      },
    });
    await navigateTool.handler({ url: URL }, handlerContext(client));
    assert.deepEqual(seen, [false]);
  });

  test("a dialog opened by the navigation is reported in the text and the details", async () => {
    const dialog = { type: "confirm", message: "Leave page?" } as const;
    const { client } = await navigating({ "Page.navigate": ok({ frameId: "f1" }) }, { pageInfo: alwaysPageInfo(dialogOf(dialog)) });
    const r = await navigateTool.handler({ url: URL }, handlerContext(client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, `Navigated to ${URL}\nTarget: t1\n⚠️  Dialog open: confirm — "Leave page?"\nUse browser_handle_dialog.`);
    assert.deepEqual(r.data.details, { outcome: { kind: "in_place", targetId: "t1" }, dialog });
  });

  test("a navigation failure is a cdp_error naming Page.navigate", async () => {
    const { client } = await navigating({ "Page.navigate": err(cdpError("remote_error", "net::ERR_NAME_NOT_RESOLVED")) });
    const r = await navigateTool.handler({ url: URL }, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "net::ERR_NAME_NOT_RESOLVED");
    assert.deepEqual(r.error.details, { method: "Page.navigate" });
  });

  test("a navigation timeout keeps the timeout kind", async () => {
    const { client } = await navigating({ "Page.navigate": err(cdpError("timeout", "slow")) });
    const r = await navigateTool.handler({ url: URL }, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
  });

  test("a tab-listing failure is attributed to Target.getTargets and nothing is navigated", async () => {
    const { fake, client } = await navigating({}, { listTabs: () => Promise.resolve(err(cdpError("transport_closed", "closed"))) });
    const r = await navigateTool.handler({ url: URL }, handlerContext(client));
    assert.equal(r.success, false);
    assert.deepEqual(r.error.details, { method: "Target.getTargets" });
    assert.equal(fake.calls.length, 0);
  });

  test("a new-tab failure is attributed to Target.createTarget", async () => {
    const { client } = await navigating({}, {
      listTabs: () => Promise.resolve(ok([])),
      newTab: () => Promise.resolve(err(cdpError("remote_error", "blocked"))),
    });
    const r = await navigateTool.handler({ url: URL }, handlerContext(client));
    assert.equal(r.success, false);
    assert.deepEqual(r.error.details, { method: "Target.createTarget" });
  });

  test("a page-info failure after a successful navigation is surfaced", async () => {
    const { client } = await navigating({ "Page.navigate": ok({ frameId: "f1" }) }, {
      pageInfo: alwaysPageInfo(pageInfoError("remote_error", "ctx destroyed", "Runtime.evaluate")),
    });
    const r = await navigateTool.handler({ url: URL }, handlerContext(client));
    assert.equal(r.success, false);
    assert.deepEqual(r.error.details, { method: "Runtime.evaluate" });
  });

  test("losing the current target after navigating is an internal error", async () => {
    const { client } = await navigating({ "Page.navigate": ok({ frameId: "f1" }) }, { current: () => null });
    const r = await navigateTool.handler({ url: URL }, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "internal");
    assert.match(r.error.message, /no current target tracked/);
  });
});

describe("browser_open_urls", () => {
  const A = "https://example.test/a";
  const B = "https://example.test/b";

  // t1 is the fake's attached tab and harness window; new tabs are its children and borrow throwaway sessions.
  const opening = (canned: Canned = {}, evaluate?: (expression: string) => boolean): Promise<FakeClient> =>
    createFakeClient({
      canned: {
        "Target.createTarget": [ok({ targetId: "t2" }), ok({ targetId: "t3" })],
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s2" }), ok({ sessionId: "s3" })],
        "Page.navigate": ok({ frameId: "f" }),
        ...canned,
      },
      evaluate: (expression) => ok(evaluate ? evaluate(expression) : expression.includes("readyState") ? true : undefined),
    });

  const updates = (fake: FakeClient): { ctx: HandlerContext; seen: string[] } => {
    const seen: string[] = [];
    const base = handlerContext(fake.client);
    return { seen, ctx: { ...base, onUpdate: (u) => { seen.push(u.text); } } };
  };

  test("opens one child tab per url in the harness window, navigates each on a borrowed session, then activates the last", async () => {
    const fake = await opening();
    const { ctx, seen } = updates(fake);
    const r = await openUrlsTool.handler({ urls: [A, B] }, ctx);
    assert.equal(r.success, true);
    assert.deepEqual(fake.callsTo("Target.createTarget").map((c) => c.params), [
      { url: "about:blank", openerId: "t1" },
      { url: "about:blank", openerId: "t1" },
    ]);
    assert.deepEqual(fake.callsTo("Target.attachToTarget").map((c) => c.params), [
      { targetId: "t2", flatten: true },
      { targetId: "t3", flatten: true },
    ]);
    assert.deepEqual(fake.callsTo("Page.enable").map((c) => c.sessionId), ["s2", "s3"]);
    assert.deepEqual(fake.callsTo("Page.navigate").map((c) => [c.params["url"], c.sessionId]), [[A, "s2"], [B, "s3"]]);
    assert.deepEqual(fake.callsTo("Target.detachFromTarget").map((c) => c.params["sessionId"]).sort(), ["s2", "s3"]);
    assert.deepEqual(fake.callsTo("Target.activateTarget").map((c) => c.params), [{ targetId: "t3" }]);
    assert.equal(r.data.text, `✅ 2/2 tabs opened:\n  [0] ${A} → t2\n  [1] ${B} → t3`);
    assert.deepEqual(r.data.details, {
      tabs: [{ url: A, targetId: "t2", ok: true }, { url: B, targetId: "t3", ok: true }],
    });
    assert.deepEqual(seen, ["Opening URLs… 1/2 navigated", "Opening URLs… 2/2 navigated"]);
    assert.equal(fake.client.owns("t2") && fake.client.owns("t3"), true);
  });

  test("the title marker is applied only after the document reports complete", async () => {
    let polls = 0;
    const fake = await opening({}, (expression) => {
      if (expression.includes("readyState")) return ++polls >= 2;
      return false;
    });
    const r = await openUrlsTool.handler({ urls: [A] }, handlerContext(fake.client));
    assert.equal(r.success, true);
    const marker = fake.evaluated.findIndex((e) => e.includes("🟢"));
    assert.ok(marker >= 0, "no title marker was evaluated");
    assert.ok(fake.evaluated.slice(0, marker).every((e) => e.includes("readyState")), "marker ran before the load poll finished");
    assert.equal(fake.evaluated.slice(0, marker).length, 2);
    assert.doesNotMatch(r.data.text, /still loading/);
  });

  test("a tab that never finishes loading is reported as still loading, not failed", async () => {
    const ac = new AbortController();
    const fake = await opening({}, () => {
      ac.abort();
      return false;
    });
    const r = await openUrlsTool.handler({ urls: [A] }, handlerContext(fake.client, ac.signal));
    assert.equal(r.success, true);
    assert.equal(r.data.text, `✅ 1/1 tabs opened:\n  [0] ${A} → t2 (still loading)`);
    assert.deepEqual(r.data.details?.["tabs"], [{ url: A, targetId: "t2", ok: true, note: "still loading" }]);
    assert.equal(fake.evaluated.some((e) => e.includes("🟢")), false, "the marker must not run on an unloaded document");
    assert.deepEqual(fake.callsTo("Target.detachFromTarget").map((c) => c.params), [{ sessionId: "s2" }]);
  });

  test("a tab whose creation fails is listed as failed while the others still open", async () => {
    const fake = await opening({
      "Target.createTarget": [ok({ targetId: "t2" }), err(cdpError("remote_error", "too many tabs"))],
      "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s2" })],
    });
    const r = await openUrlsTool.handler({ urls: [A, B] }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, `✅ 1/2 tabs opened:\n  [0] ${A} → t2\n❌ 1/2 failed:\n  ${B}: too many tabs`);
    assert.deepEqual(r.data.details?.["tabs"], [
      { url: A, targetId: "t2", ok: true },
      { url: B, targetId: "", ok: false, error: "too many tabs" },
    ]);
    assert.deepEqual(fake.callsTo("Target.activateTarget").map((c) => c.params), [{ targetId: "t2" }]);
  });

  test("a navigation failure marks that tab failed and still releases its session", async () => {
    const fake = await opening({ "Page.navigate": err(cdpError("remote_error", "net::ERR_FAILED")) });
    const r = await openUrlsTool.handler({ urls: [A] }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "All 1 URLs failed");
    assert.deepEqual(r.error.details?.["tabs"], [{ url: A, targetId: "t2", ok: false, error: "net::ERR_FAILED" }]);
    assert.deepEqual(fake.callsTo("Target.detachFromTarget").map((c) => c.params), [{ sessionId: "s2" }]);
    assert.equal(fake.callsTo("Target.activateTarget").length, 0);
  });

  test("a Page.enable failure on the borrowed session fails that tab", async () => {
    const fake = await opening({ "Page.enable": [ok({}), err(cdpError("remote_error", "no page domain"))] });
    const r = await openUrlsTool.handler({ urls: [A] }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.match(r.error.message, /All 1 URLs failed/);
    assert.equal(fake.callsTo("Page.navigate").length, 0);
    assert.deepEqual(fake.callsTo("Target.detachFromTarget").map((c) => c.params), [{ sessionId: "s2" }]);
  });

  test("a failed borrow (attach) fails that tab without a detach", async () => {
    const fake = await opening({ "Target.attachToTarget": [ok({ sessionId: "s1" }), err(cdpError("timeout", "no attach"))] });
    const r = await openUrlsTool.handler({ urls: [A] }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.deepEqual(r.error.details?.["tabs"], [{ url: A, targetId: "t2", ok: false, error: "no attach" }]);
    assert.equal(fake.callsTo("Target.detachFromTarget").length, 0);
  });

  test("no urls is invalid_args before any target is touched", async () => {
    const fake = await opening();
    const r = await openUrlsTool.handler({ urls: [] }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
    assert.equal(r.error.message, "no URLs provided");
    assert.equal(fake.calls.length, 0);
  });

  test("a harness-window failure is a cdp_error attributed to Target.createTarget", async () => {
    const fake = await opening({
      "Target.getTargets": [
        ok({ targetInfos: [{ targetId: "t1", type: "page", title: "Fake", url: "https://example.test/" }] }),
        err(cdpError("transport_closed", "closed")),
      ],
    });
    const r = await openUrlsTool.handler({ urls: [A] }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "Target.createTarget" });
  });

  test("a renderer that throws on progress does not fail the tool", async () => {
    const fake = await opening();
    const ctx: HandlerContext = { ...handlerContext(fake.client), onUpdate: () => { throw new Error("renderer crashed"); } };
    const r = await openUrlsTool.handler({ urls: [A] }, ctx);
    assert.equal(r.success, true);
  });

  test("when the harness window is gone the first url seeds a fresh window and the rest are its children", async () => {
    const fake = await opening({
      "Target.createTarget": [ok({ targetId: "w1" }), ok({ targetId: "t3" })],
      "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "sw" }), ok({ sessionId: "s3" })],
    });
    // Chrome reports the harness tab closed; the session drops it from ownership and the harness window.
    fake.emit({ method: "Target.targetDestroyed", params: { targetId: "t1" } });
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(fake.client.ownership().harnessWindow(), undefined);
    const r = await openUrlsTool.handler({ urls: [A, B] }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(fake.callsTo("Target.createTarget").map((c) => c.params), [
      { url: "about:blank", newWindow: true },
      { url: "about:blank", openerId: "w1" },
    ]);
    assert.deepEqual(r.data.details?.["tabs"], [{ url: A, targetId: "w1", ok: true }, { url: B, targetId: "t3", ok: true }]);
    assert.equal(fake.client.ownership().harnessWindow(), "w1");
  });
});
