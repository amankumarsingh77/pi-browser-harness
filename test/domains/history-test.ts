import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient, handlerContext } from "./fake-client";
import { goBackTool, goForwardTool, reloadTool } from "../../src/domains/history";
import type { BrowserClient } from "../../src/client";
import type { PageInfoResult } from "../../src/cdp/types";
import type { CdpError } from "../../src/cdp/errors";
import { type Result, ok } from "../../src/util/result";

const THREE_ENTRIES = (currentIndex: number) =>
  ok({
    currentIndex,
    entries: [
      { id: 10, url: "https://a.test/", title: "A" },
      { id: 11, url: "https://b.test/", title: "B" },
      { id: 12, url: "https://c.test/", title: "C" },
    ],
  });

const HISTORY_FAILED: Result<never, CdpError> = { success: false, error: { kind: "remote_error", message: "no history" } };

// The fake's pageInfo is unconfigured; reload needs one, so it is layered on here without touching the fake.
const withPageInfo = (
  client: BrowserClient,
  info: Result<PageInfoResult, CdpError>,
): { readonly client: BrowserClient; readonly pageInfoCalls: () => number } => {
  let calls = 0;
  return {
    client: {
      ...client,
      pageInfo: () => {
        calls++;
        return Promise.resolve(info);
      },
    },
    pageInfoCalls: () => calls,
  };
};

const PAGE: PageInfoResult = {
  kind: "page", url: "https://a.test/", title: "A", width: 800, height: 600, scrollX: 0, scrollY: 0, pageWidth: 800, pageHeight: 600,
};

describe("browser_go_back", () => {
  test("navigates to the previous entry by id and reports its url", async () => {
    const fake = await createFakeClient({ canned: { "Page.getNavigationHistory": THREE_ENTRIES(2) } });
    const r = await goBackTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Navigated back to: https://b.test/");
    assert.deepEqual(r.data.details, { url: "https://b.test/" });
    assert.deepEqual(fake.calls.map((c) => c.method), ["Page.getNavigationHistory", "Page.navigateToHistoryEntry"]);
    assert.deepEqual(fake.callsTo("Page.navigateToHistoryEntry")[0]?.params, { entryId: 11 });
  });

  test("at the beginning of history it reports that and sends no navigation", async () => {
    const fake = await createFakeClient({ canned: { "Page.getNavigationHistory": THREE_ENTRIES(0) } });
    const r = await goBackTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Already at the beginning of history.");
    assert.equal(r.data.details, undefined);
    assert.equal(fake.callsTo("Page.navigateToHistoryEntry").length, 0);
  });

  test("a failed history read is a cdp_error naming the method", async () => {
    const fake = await createFakeClient({ canned: { "Page.getNavigationHistory": HISTORY_FAILED } });
    const r = await goBackTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "no history");
    assert.deepEqual(r.error.details, { method: "Page.getNavigationHistory" });
  });

  test("a failed navigation is a cdp_error naming the navigation method", async () => {
    const fake = await createFakeClient({
      canned: {
        "Page.getNavigationHistory": THREE_ENTRIES(1),
        "Page.navigateToHistoryEntry": { success: false, error: { kind: "timeout", message: "slow" } },
      },
    });
    const r = await goBackTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.deepEqual(r.error.details, { method: "Page.navigateToHistoryEntry" });
  });
});

describe("browser_go_forward", () => {
  test("navigates to the next entry by id and reports its url", async () => {
    const fake = await createFakeClient({ canned: { "Page.getNavigationHistory": THREE_ENTRIES(0) } });
    const r = await goForwardTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Navigated forward to: https://b.test/");
    assert.deepEqual(r.data.details, { url: "https://b.test/" });
    assert.deepEqual(fake.callsTo("Page.navigateToHistoryEntry")[0]?.params, { entryId: 11 });
  });

  test("at the end of history it reports that and sends no navigation", async () => {
    const fake = await createFakeClient({ canned: { "Page.getNavigationHistory": THREE_ENTRIES(2) } });
    const r = await goForwardTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Already at the end of history.");
    assert.equal(fake.callsTo("Page.navigateToHistoryEntry").length, 0);
  });

  test("an empty history is treated as the end", async () => {
    const fake = await createFakeClient({ canned: { "Page.getNavigationHistory": ok({ currentIndex: 0, entries: [] }) } });
    const r = await goForwardTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Already at the end of history.");
  });

  test("a failed history read is a cdp_error naming the method", async () => {
    const fake = await createFakeClient({ canned: { "Page.getNavigationHistory": HISTORY_FAILED } });
    const r = await goForwardTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "Page.getNavigationHistory" });
  });
});

describe("browser_reload", () => {
  test("reloads, then reports the page info it reads back", async () => {
    const fake = await createFakeClient();
    const wrapped = withPageInfo(fake.client, ok(PAGE));
    const r = await reloadTool.handler({}, handlerContext(wrapped.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Reloaded: A (https://a.test/)");
    assert.deepEqual(r.data.details, { page: PAGE });
    assert.deepEqual(fake.callsTo("Page.reload")[0]?.params, {});
    assert.equal(wrapped.pageInfoCalls(), 1);
  });

  test("a dialog opened by the reload is reported instead of the page", async () => {
    const fake = await createFakeClient();
    const dialog = { type: "beforeunload" as const, message: "leave?" };
    const wrapped = withPageInfo(fake.client, ok({ kind: "dialog", dialog }));
    const r = await reloadTool.handler({}, handlerContext(wrapped.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Reloaded. ⚠️ Dialog open: beforeunload");
    assert.deepEqual(r.data.details, { dialog });
  });

  test("a failed reload is a cdp_error and page info is never read", async () => {
    const fake = await createFakeClient({
      canned: { "Page.reload": { success: false, error: { kind: "remote_error", message: "reload blocked" } } },
    });
    const wrapped = withPageInfo(fake.client, ok(PAGE));
    const r = await reloadTool.handler({}, handlerContext(wrapped.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "reload blocked");
    assert.deepEqual(r.error.details, { method: "Page.reload" });
    assert.equal(wrapped.pageInfoCalls(), 0);
  });

  test("a failed page info read is a cdp_error that keeps the error's own method", async () => {
    const fake = await createFakeClient();
    const wrapped = withPageInfo(fake.client, {
      success: false,
      error: { kind: "remote_error", message: "gone", method: "Runtime.evaluate" },
    });
    const r = await reloadTool.handler({}, handlerContext(wrapped.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "gone");
    assert.deepEqual(r.error.details, { method: "Runtime.evaluate" });
  });

  test("a page info error without a method is attributed to pageInfo", async () => {
    const fake = await createFakeClient();
    const r = await reloadTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "pageInfo" });
  });
});
