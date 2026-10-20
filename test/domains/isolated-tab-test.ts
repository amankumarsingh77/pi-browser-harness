import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { type Canned, createFakeClient, type FakeClient } from "./fake-client";
import { withClient } from "./client-overrides";
import type { BrowserClient } from "../../src/client";
import {
  closeIsolatedTab,
  evalInIsolatedTab,
  isJsonText,
  navigateIsolatedTab,
  openIsolatedTab,
} from "../../src/domains/isolated-tab";
import { cdpError } from "../../src/cdp/errors";
import { err, ok } from "../../src/util/result";

// The fake attaches t1 as s1 and adopts it as the harness window, so an isolated tab is opened as t1's child and
// receives the second attach result.
const harness = (canned: Canned = {}): Promise<FakeClient> =>
  createFakeClient({
    canned: {
      "Target.createTarget": ok({ targetId: "t2" }),
      "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-iso" })],
      ...canned,
    },
  });

const TAB = { targetId: "t2", sessionId: "s-iso" };

// The fake's closeTab never reaches the transport, so the ids handed to it are recorded here instead.
const closing = (fake: FakeClient): { client: BrowserClient; closed: string[] } => {
  const closed: string[] = [];
  const client = withClient(fake.client, {
    closeTab: (id) => {
      closed.push(id);
      return Promise.resolve(ok(undefined));
    },
  });
  return { client, closed };
};

describe("openIsolatedTab", () => {
  test("opens a child of the harness window, attaches a flat session and enables Page on it", async () => {
    const fake = await harness();
    const r = await openIsolatedTab(fake.client);
    assert.deepEqual(r, { success: true, data: TAB });
    assert.deepEqual(fake.calls.map((c) => [c.method, c.params, c.sessionId]), [
      ["Target.getTargets", {}, null],
      ["Target.createTarget", { url: "about:blank", openerId: "t1" }, null],
      ["Target.attachToTarget", { targetId: "t2", flatten: true }, null],
      ["Page.enable", {}, "s-iso"],
    ]);
    assert.equal(fake.client.owns("t2"), true, "the isolated tab is owned so the harness may close it");
    assert.equal(fake.session.sessionFor("t2"), undefined, "the session is raw, not tracked");
  });

  test("a failed createTarget is a cdp_error naming Target.createTarget", async () => {
    const fake = await harness({ "Target.createTarget": err(cdpError("remote_error", "blocked")) });
    const r = await openIsolatedTab(fake.client);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "blocked");
    assert.deepEqual(r.error.details, { method: "Target.createTarget" });
    assert.equal(fake.callsTo("Target.attachToTarget").length, 0);
  });

  test("a failed attach closes the tab it just opened", async () => {
    const fake = await harness({ "Target.attachToTarget": [ok({ sessionId: "s1" }), err(cdpError("timeout", "no attach"))] });
    const { client, closed } = closing(fake);
    const r = await openIsolatedTab(client);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.deepEqual(r.error.details, { method: "Target.attachToTarget" });
    assert.deepEqual(closed, ["t2"]);
    assert.equal(fake.callsTo("Page.enable").length, 0);
  });

  test("a failed Page.enable closes the tab too", async () => {
    // The first Page.enable belongs to the fake's own attach; the second is the isolated tab's.
    const fake = await harness({ "Page.enable": [ok({}), err(cdpError("remote_error", "nope"))] });
    const { client, closed } = closing(fake);
    const r = await openIsolatedTab(client);
    assert.equal(r.success, false);
    assert.deepEqual(r.error.details, { method: "Page.enable" });
    assert.deepEqual(closed, ["t2"]);
  });

  test("a failed target listing is reported as the createTarget step", async () => {
    const fake = await harness({
      "Target.getTargets": [
        ok({ targetInfos: [{ targetId: "t1", type: "page", title: "Fake", url: "https://example.test/" }] }),
        err(cdpError("transport_closed", "closed")),
      ],
    });
    const r = await openIsolatedTab(fake.client);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "Target.createTarget" });
  });
});

describe("navigateIsolatedTab", () => {
  test("navigates on the isolated session", async () => {
    const fake = await harness({ "Page.navigate": ok({ frameId: "f" }) });
    const r = await navigateIsolatedTab(fake.client, TAB, "https://example.test/x");
    assert.deepEqual(r, { success: true, data: undefined });
    assert.deepEqual(fake.calls.map((c) => [c.method, c.params, c.sessionId]), [
      ["Page.navigate", { url: "https://example.test/x" }, "s-iso"],
    ]);
  });

  test("a navigation error keeps its kind and names Page.navigate", async () => {
    const fake = await harness({ "Page.navigate": err(cdpError("timeout", "slow")) });
    const r = await navigateIsolatedTab(fake.client, TAB, "https://example.test/x");
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.deepEqual(r.error.details, { method: "Page.navigate" });
  });
});

describe("evalInIsolatedTab", () => {
  test("evaluates by value on the isolated session and returns the checked value", async () => {
    const fake = await harness({ "Runtime.evaluate": ok({ result: { type: "string", value: '{"a":1}' } }) });
    const r = await evalInIsolatedTab(fake.client, TAB, "JSON.stringify(x)", isJsonText);
    assert.deepEqual(r, { success: true, data: '{"a":1}' });
    assert.deepEqual(fake.calls.map((c) => [c.method, c.params, c.sessionId]), [
      ["Runtime.evaluate", { expression: "JSON.stringify(x)", returnByValue: true, awaitPromise: true }, "s-iso"],
    ]);
  });

  test("a value of the wrong shape is a cdp_error naming Runtime.evaluate", async () => {
    const fake = await harness({ "Runtime.evaluate": ok({ result: { type: "number", value: 1 } }) });
    const r = await evalInIsolatedTab(fake.client, TAB, "1", isJsonText);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.match(r.error.message, /unexpected evaluate shape \(type: number\)/);
    assert.deepEqual(r.error.details, { method: "Runtime.evaluate" });
  });

  test("a page exception is reported with its text", async () => {
    const fake = await harness({
      "Runtime.evaluate": ok({ result: { type: "undefined" }, exceptionDetails: { text: "Uncaught ReferenceError" } }),
    });
    const r = await evalInIsolatedTab(fake.client, TAB, "boom()", isJsonText);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "Uncaught ReferenceError");
  });

  test("a transport timeout keeps the timeout kind", async () => {
    const fake = await harness({ "Runtime.evaluate": err(cdpError("timeout", "no reply")) });
    const r = await evalInIsolatedTab(fake.client, TAB, "1", isJsonText);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
  });

  test("isJsonText accepts only strings", () => {
    assert.equal(isJsonText("x"), true);
    assert.equal(isJsonText(""), true);
    assert.equal(isJsonText(1), false);
    assert.equal(isJsonText(null), false);
    assert.equal(isJsonText({ a: 1 }), false);
  });
});

describe("closeIsolatedTab", () => {
  test("closes the target through the client", async () => {
    const fake = await harness();
    const r = await openIsolatedTab(fake.client);
    assert.equal(r.success, true);
    const { client, closed } = closing(fake);
    await closeIsolatedTab(client, r.data);
    assert.deepEqual(closed, ["t2"]);
  });
});
