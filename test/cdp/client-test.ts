import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createBrowserClient } from "../../src/client";
import { createStubTransport, flush, type Canned } from "../domains/fake-client";
import { ok } from "../../src/util/result";

const PAGE_JSON = JSON.stringify({ url: "https://one.test/", title: "One", w: 1, h: 2, sx: 0, sy: 0, pw: 3, ph: 4 });

const started = async (canned: Canned = {}, closeConfirmMs?: number) => {
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
    ...(closeConfirmMs !== undefined ? { closeConfirmMs } : {}),
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
  test("sends a body with statements before its return wrapped in an awaited async function, in REPL mode", async () => {
    const { stub, client } = await started();
    stub.calls.length = 0;

    await client.evaluateJs("const t = document.title; return t");

    const [sent] = stub.calls.filter((c) => c.method === "Runtime.evaluate");
    assert.equal(sent?.params["expression"], "await (async () => {\nconst t = document.title; return t\n})()");
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

describe("BrowserClient.closeTab", () => {
  test("a tab Chrome no longer lists after the close is closed with one Target.closeTarget and leaves the owned list", async () => {
    const { stub, client } = await started({ "Target.closeTarget": ok({ success: true }) }, 50);

    // t9 is not among the targets Chrome lists, as after a close that took.
    client.ownership().add("t9");
    const r = await client.closeTab("t9");

    assert.equal(r.success, true);
    assert.equal(stub.calls.filter((c) => c.method === "Target.closeTarget").length, 1);
    assert.equal(client.owns("t9"), false);
  });

  test("a tab Chrome still lists after the close (a page still loading) is closed twice, then reported as still open and kept owned", async () => {
    const { stub, client } = await started({ "Target.closeTarget": ok({ success: true }) }, 50);

    const r = await client.closeTab("t1");

    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.match(r.error.message, /tab t1 is still open after 2 attempts/);
    assert.equal(stub.calls.filter((c) => c.method === "Target.closeTarget").length, 2);
    assert.equal(client.owns("t1"), true);
  });
});

describe("BrowserClient profile pin against a remote browser", () => {
  const PIN = { userDataDir: "/home/u/.config/google-chrome", profileDir: "Default", label: "Alice", savedAt: "" };

  // No `remote` option, so start() runs the injected discovery; no pin is set before start(), so nothing is seeded.
  const discovered = async (opts: { readonly userDataDir?: string; readonly running: boolean; readonly wsUrl?: string }) => {
    const stub = createStubTransport({
      "Target.setDiscoverTargets": ok({}),
      "Target.getTargets": ok({ targetInfos: [{ targetId: "t1", type: "page", title: "One", url: "https://one.test/" }] }),
      "Target.attachToTarget": ok({ sessionId: "s1" }),
      "Browser.getWindowForTarget": ok({ windowId: 7 }),
      "Target.activateTarget": ok({}),
      "Runtime.evaluate": ok({ result: { type: "string", value: PAGE_JSON } }),
    });
    const client = createBrowserClient({
      namespace: "test",
      transport: stub.transport,
      initialOwnership: { ownedTargetIds: ["t1"] },
      discoverEndpoint: () => Promise.resolve(ok({
        wsUrl: opts.wsUrl ?? "ws://127.0.0.1:9222/devtools/browser/abc",
        ...(opts.userDataDir === undefined ? {} : { userDataDir: opts.userDataDir }),
      })),
      isBrowserRunning: () => Promise.resolve(opts.running),
    });
    const r = await client.start();
    assert.equal(r.success, true);
    return client;
  };

  test("an endpoint with no user-data-dir and no local browser process suspends the pin", async () => {
    const client = await discovered({ running: false });
    client.setProfilePin(PIN);
    assert.equal(client.profilePin(), null);
    const seeded = await client.seedPinnedProfileWindow();
    assert.equal(seeded.success, false);
  });

  test("an endpoint with no user-data-dir but a local browser process keeps the pin", async () => {
    const client = await discovered({ running: true });
    client.setProfilePin(PIN);
    assert.deepEqual(client.profilePin(), PIN);
  });

  test("an endpoint on another host suspends the pin even while an unrelated browser runs here", async () => {
    const client = await discovered({ running: true, wsUrl: "ws://example.test/devtools/browser/abc" });
    client.setProfilePin(PIN);
    assert.equal(client.profilePin(), null);
  });

  test("an endpoint from a local port file keeps the pin without asking about processes", async () => {
    const client = await discovered({ userDataDir: PIN.userDataDir, running: false });
    client.setProfilePin(PIN);
    assert.deepEqual(client.profilePin(), PIN);
  });
});
