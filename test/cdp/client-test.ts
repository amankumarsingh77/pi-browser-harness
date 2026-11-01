import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createBrowserClient } from "../../src/client";
import { createStubTransport, flush, type Canned } from "../domains/fake-client";
import { ok } from "../../src/util/result";

const PAGE_JSON = JSON.stringify({ url: "https://one.test/", title: "One", w: 1, h: 2, sx: 0, sy: 0, pw: 3, ph: 4 });

const started = async (canned: Canned = {}) => {
  const stub = createStubTransport({
    "Target.setDiscoverTargets": ok({}),
    "Target.getTargets": ok({
      targetInfos: [
        { targetId: "t1", type: "page", title: "One", url: "https://one.test/" },
        { targetId: "t2", type: "page", title: "Two", url: "https://two.test/" },
      ],
    }),
    "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s2" })],
    "Browser.getWindowForTarget": ok({ windowId: 7 }),
    "Target.activateTarget": ok({}),
    "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    ...canned,
  });
  const client = createBrowserClient({
    namespace: "test",
    transport: stub.transport,
    remote: { cdpUrl: "ws://127.0.0.1:1/devtools/browser/abc", browserId: "abc" },
    initialOwnership: { ownedTargetIds: ["t1"] },
  });
  const r = await client.start();
  assert.equal(r.success, true);
  return { stub, client };
};

describe("BrowserClient.pageInfo", () => {
  test("a plain page is tagged kind: page and keeps the PageInfo fields", async () => {
    const { client } = await started();
    const info = await client.pageInfo();
    assert.equal(info.success, true);
    assert.equal(info.data.kind, "page");
    assert.equal(info.data.url, "https://one.test/");
    assert.equal("dialog" in info.data, false);
  });

  test("a pending dialog is tagged kind: dialog and still narrows with `\"dialog\" in`", async () => {
    const { stub, client } = await started();
    stub.emit({ method: "Page.javascriptDialogOpening", sessionId: "s1", params: { type: "confirm", message: "sure?" } });
    await flush();
    const info = await client.pageInfo();
    assert.equal(info.success, true);
    assert.equal(info.data.kind, "dialog");
    assert.equal("dialog" in info.data, true);
    assert.equal(info.data.dialog.message, "sure?");
  });
});

describe("BrowserClient.detach", () => {
  test("detaches every tracked session, not only the current one", async () => {
    const { stub, client } = await started();
    const switched = await client.switchTab("t2");
    assert.equal(switched.success, true);
    await client.detach();
    const detached = stub.calls
      .filter((c) => c.method === "Target.detachFromTarget")
      .map((c) => c.params["sessionId"]);
    assert.deepEqual(detached.sort(), ["s1", "s2"]);
    assert.equal(client.current(), null);
  });
});

describe("BrowserClient.ensureAlive", () => {
  test("concurrent callers share one in-flight check", async () => {
    const { stub, client } = await started();
    // Forget the current tab so the next ensureAlive has to restart, which attaches again.
    stub.emit({ method: "Target.targetDestroyed", params: { targetId: "t1" } });
    await flush();
    assert.equal(client.current(), null);
    const attachesBefore = stub.calls.filter((c) => c.method === "Target.attachToTarget").length;
    const [a, b, c] = await Promise.all([client.ensureAlive(), client.ensureAlive(), client.ensureAlive()]);
    assert.equal(a.success && b.success && c.success, true);
    assert.equal(stub.calls.filter((c) => c.method === "Target.attachToTarget").length, attachesBefore + 1);
  });
});

describe("BrowserClient.evaluateJs", () => {
  test("sends a body with statements before its return wrapped in an async function, in REPL mode", async () => {
    const { stub, client } = await started();
    stub.calls.length = 0;

    await client.evaluateJs("const t = document.title; return t");

    const [sent] = stub.calls.filter((c) => c.method === "Runtime.evaluate");
    assert.equal(sent?.params["expression"], "(async () => {\nconst t = document.title; return t\n})()");
    assert.equal(sent.params["replMode"], true);
  });
});

describe("BrowserClient.pageInfo after a navigation command", () => {
  test("a Page.navigate that returns before Page.frameNavigated arrives still makes the next pageInfo read the page again", async () => {
    const { stub, client } = await started({ "Page.navigate": ok({ frameId: "f1" }) });
    const evaluations = (): number => stub.calls.filter((c) => c.method === "Runtime.evaluate").length;
    await client.pageInfo();
    const before = evaluations();

    await client.session().call("Page.navigate", { url: "https://two.test/" });
    await client.pageInfo();

    assert.equal(evaluations(), before + 1);
  });
});
