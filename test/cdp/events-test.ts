import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { EVENTS, decodeEvent, isKnownEvent } from "../../src/cdp/events";
import { createConsoleBuffer } from "../../src/cdp/console-buffer";
import { createNetworkBuffer } from "../../src/cdp/network-buffer";

describe("cdp events", () => {
  test("decodes a dialog-opening event", () => {
    const r = decodeEvent("Page.javascriptDialogOpening", { type: "confirm", message: "Sure?" });
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.data.type, "confirm");
  });

  test("rejects a malformed event payload", () => {
    const r = decodeEvent("Page.javascriptDialogOpening", { type: 5 });
    assert.equal(r.success, false);
    if (!r.success) {
      assert.equal(r.error.kind, "invalid_response");
      assert.equal(r.error.method, "Page.javascriptDialogOpening");
    }
  });

  test("tolerates unknown extra fields Chrome may add", () => {
    const r = decodeEvent("Target.targetDestroyed", { targetId: "t1", extra: true });
    assert.equal(r.success, true);
  });

  test("isKnownEvent gates unrecognised methods", () => {
    assert.equal(isKnownEvent("Page.loadEventFired"), true);
    assert.equal(isKnownEvent("Fetch.requestPaused"), false);
  });

  test("the table covers exactly the events the codebase dispatches on", () => {
    assert.deepEqual(Object.keys(EVENTS).sort(), [
      "Inspector.detached",
      "Log.entryAdded",
      "Network.loadingFailed",
      "Network.loadingFinished",
      "Network.requestWillBeSent",
      "Network.responseReceived",
      "Page.frameNavigated",
      "Page.javascriptDialogOpening",
      "Page.loadEventFired",
      "Page.screencastFrame",
      "Runtime.consoleAPICalled",
      "Target.targetCreated",
      "Target.targetDestroyed",
    ]);
  });

  test("a non-object payload decodes to an error rather than throwing", () => {
    assert.equal(decodeEvent("Target.targetDestroyed", null).success, false);
    assert.equal(decodeEvent("Log.entryAdded", undefined).success, false);
  });

  test("targetCreated keeps openerId optional", () => {
    const r = decodeEvent("Target.targetCreated", {
      targetInfo: { targetId: "t1", type: "page", title: "x", url: "about:blank" },
    });
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.data.targetInfo.openerId, undefined);
  });
});

describe("cdp events dropped payloads", () => {
  test("console buffer ignores a malformed Log.entryAdded without throwing", () => {
    const buf = createConsoleBuffer();
    buf.ingestLogEntry({ entry: { level: "error", text: 42 } });
    assert.deepEqual(buf.drain({}).records, []);
  });

  test("console buffer still records a well-formed Log.entryAdded", () => {
    const buf = createConsoleBuffer();
    buf.ingestLogEntry({ entry: { level: "error", text: "boom" } });
    const drained = buf.drain({});
    assert.equal(drained.records.length, 1);
    assert.equal(drained.records[0]?.text, "boom");
    assert.equal(drained.records[0]?.level, "error");
  });

  test("network buffer ignores a malformed requestWillBeSent without throwing", () => {
    const buf = createNetworkBuffer();
    buf.ingestRequestWillBeSent({ requestId: "r1", request: { url: 7, method: "GET" } });
    assert.deepEqual(buf.drain({}).records, []);
  });

  test("network buffer keeps an existing record when a later event is malformed", () => {
    const buf = createNetworkBuffer();
    buf.ingestRequestWillBeSent({ requestId: "r1", request: { url: "https://a/", method: "GET" } });
    buf.ingestResponseReceived({ requestId: "r1", response: { status: "200" } });
    const drained = buf.drain({});
    assert.equal(drained.records.length, 1);
    assert.equal(drained.records[0]?.status, undefined);
  });
});
