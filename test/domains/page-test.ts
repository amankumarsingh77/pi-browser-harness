import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient, handlerContext } from "./fake-client";
import { alwaysPageInfo, dialogOf, pageInfoError, pageInfoOf, withClient } from "./client-overrides";
import { pageInfoTool, waitForLoadTool, waitForTool, waitTool } from "../../src/domains/page";
import { READY_STATE_COMPLETE } from "../../src/domains/poll";
import { ok } from "../../src/util/result";

describe("browser_page_info", () => {
  test("reports url, title, viewport, scroll and page size, and spreads the info into details", async () => {
    const fake = await createFakeClient();
    const client = withClient(fake.client, { pageInfo: alwaysPageInfo(pageInfoOf()) });
    const r = await pageInfoTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.equal(
      r.data.text,
      "URL: https://example.test/page\nTitle: Example\nViewport: 1000x600\nScroll: (0, 120)\nPage size: 1000x4000",
    );
    assert.deepEqual(r.data.details, {
      kind: "page",
      url: "https://example.test/page",
      title: "Example",
      width: 1000,
      height: 600,
      scrollX: 0,
      scrollY: 120,
      pageWidth: 1000,
      pageHeight: 4000,
    });
    assert.equal(fake.calls.length, 0, "page info comes from the client, not a direct CDP call");
  });

  test("an open alert is reported instead of the page, without a Default line", async () => {
    const fake = await createFakeClient();
    const dialog = { type: "alert", message: "Saved!" } as const;
    const client = withClient(fake.client, { pageInfo: alwaysPageInfo(dialogOf(dialog)) });
    const r = await pageInfoTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /DIALOG OPEN: alert\nMessage: Saved!\n\nUse browser_handle_dialog/);
    assert.doesNotMatch(r.data.text, /Default:/);
    assert.deepEqual(r.data.details, { dialog });
  });

  test("an open prompt carries its default value", async () => {
    const fake = await createFakeClient();
    const dialog = { type: "prompt", message: "Name?", defaultPrompt: "anon" } as const;
    const client = withClient(fake.client, { pageInfo: alwaysPageInfo(dialogOf(dialog)) });
    const r = await pageInfoTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /DIALOG OPEN: prompt\nMessage: Name\?\nDefault: anon\n/);
    assert.deepEqual(r.data.details, { dialog });
  });

  test("a beforeunload dialog is reported like any other", async () => {
    const fake = await createFakeClient();
    const client = withClient(fake.client, {
      pageInfo: alwaysPageInfo(dialogOf({ type: "beforeunload", message: "" })),
    });
    const r = await pageInfoTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /DIALOG OPEN: beforeunload/);
  });

  test("a client error keeps its CDP method and maps a timeout to the timeout kind", async () => {
    const fake = await createFakeClient();
    const slow = withClient(fake.client, { pageInfo: alwaysPageInfo(pageInfoError("timeout", "slow", "Runtime.evaluate")) });
    const r = await pageInfoTool.handler({}, handlerContext(slow));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.equal(r.error.message, "slow");
    assert.deepEqual(r.error.details, { method: "Runtime.evaluate" });
  });

  test("a client error without a method is attributed to pageInfo", async () => {
    const fake = await createFakeClient();
    const bad = withClient(fake.client, { pageInfo: alwaysPageInfo(pageInfoError("invalid_response", "bad payload")) });
    const r = await pageInfoTool.handler({}, handlerContext(bad));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "pageInfo" });
  });
});

describe("browser_wait", () => {
  test("waits the requested time and reports it", async () => {
    const fake = await createFakeClient();
    const started = Date.now();
    const r = await waitTool.handler({ seconds: 0.02 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Waited 0.02s");
    assert.equal(r.data.details, undefined);
    assert.ok(Date.now() - started >= 15, "the handler returned before the wait elapsed");
  });

  test("zero seconds resolves immediately", async () => {
    const fake = await createFakeClient();
    const r = await waitTool.handler({ seconds: 0 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Waited 0s");
  });
});

describe("browser_wait_for_load", () => {
  test("polls document.readyState and reports the elapsed time", async () => {
    let calls = 0;
    const fake = await createFakeClient({ evaluate: () => ok(++calls >= 2) });
    const r = await waitForLoadTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(fake.evaluated, [READY_STATE_COMPLETE, READY_STATE_COMPLETE]);
    assert.match(r.data.text, /^Page loaded in \d+(\.\d)?s$/);
    const details = r.data.details ?? {};
    assert.equal(typeof details["ms"], "number");
  });

  test("the timeout argument is in seconds and names the page load in the error", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(false) });
    const started = Date.now();
    const r = await waitForLoadTool.handler({ timeout: 1 }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.equal(r.error.message, "Timed out after 1s waiting for page load");
    assert.ok(Date.now() - started >= 950, "returned before the one-second deadline");
  });

  test("an evaluation error mid-navigation is retried rather than surfaced", async () => {
    let calls = 0;
    const fake = await createFakeClient({
      evaluate: () => {
        calls++;
        return calls < 3 ? { success: false, error: { kind: "remote_error", message: "context destroyed" } } : ok(true);
      },
    });
    const r = await waitForLoadTool.handler({ timeout: 5 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(calls, 3);
  });
});

describe("browser_wait_for", () => {
  test("a selector waits for presence by default", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(true) });
    const r = await waitForTool.handler({ selector: "#done" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /^Condition met \(#done\) in \d+(\.\d)?s$/);
    const expr = fake.evaluated[0] ?? "";
    assert.match(expr, /document\.querySelector\("#done"\)/);
    assert.match(expr, /return false \? !found : found/);
  });

  test("gone:true inverts the selector condition and says so", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(true) });
    const r = await waitForTool.handler({ selector: ".spinner", gone: true }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /^Condition met \(\.spinner gone\)/);
    assert.match(fake.evaluated[0] ?? "", /return true \? !found : found/);
  });

  test("text waits for body.innerText to include the JSON-encoded string", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(true) });
    const r = await waitForTool.handler({ text: 'say "hi"' }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text.startsWith('Condition met (text "say "hi"")'), true);
    assert.match(fake.evaluated[0] ?? "", /t\.includes\("say \\"hi\\""\)/);
  });

  test("a selector takes precedence when both selector and text are given", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(true) });
    const r = await waitForTool.handler({ selector: "#a", text: "b" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /\(#a\)/);
    assert.doesNotMatch(fake.evaluated[0] ?? "", /innerText/);
  });

  test("a timeout names the selector and the disappear intent", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(false) });
    const r = await waitForTool.handler({ selector: "#x", gone: true, timeout: 1 }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.equal(r.error.message, "Timed out after 1s waiting for #x to disappear");
  });

  test("a timeout waiting for text quotes the text", async () => {
    const ac = new AbortController();
    const fake = await createFakeClient({
      evaluate: () => {
        ac.abort();
        return ok(false);
      },
    });
    const r = await waitForTool.handler({ text: "welcome" }, handlerContext(fake.client, ac.signal));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.equal(r.error.message, 'Aborted while waiting for text "welcome"');
  });
});
