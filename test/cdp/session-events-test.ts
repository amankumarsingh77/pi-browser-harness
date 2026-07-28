import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { createCdpSession } from "../../src/cdp/session";
import { createOwnershipRegistry } from "../../src/cdp/ownership";
import { createStubTransport } from "../domains/fake-client";
import { ok } from "../../src/util/result";

const flush = async (): Promise<void> => {
  await tick();
  await tick();
};

const twoTabSession = async () => {
  const stub = createStubTransport({
    "Target.setDiscoverTargets": ok({}),
    "Target.getTargets": ok({
      targetInfos: [
        { targetId: "t1", type: "page", title: "One", url: "https://one.test/" },
        { targetId: "t2", type: "page", title: "Two", url: "https://two.test/" },
      ],
    }),
    "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s2" }), ok({ sessionId: "s3" })],
    "Browser.getWindowForTarget": ok({ windowId: 7 }),
    "Target.activateTarget": ok({}),
  });
  const ownership = createOwnershipRegistry({ ownedTargetIds: ["t1", "t2"] });
  const session = createCdpSession(stub.transport, ownership);
  const attached = await session.attachFirstPage();
  assert.equal(attached.success, true);
  await session.switchTo("t2");
  return { stub, session };
};

describe("CdpSession event routing across tabs", () => {
  test("a console event from a background tab reaches that tab's buffer", async () => {
    const { stub, session } = await twoTabSession();
    stub.emit({
      method: "Runtime.consoleAPICalled",
      sessionId: "s1",
      params: { type: "error", args: [{ type: "string", value: "boom" }] },
    });
    await flush();
    assert.equal(session.drainConsoleBuffer({}).records.length, 0);
    await session.switchTo("t1");
    const drained = session.drainConsoleBuffer({});
    assert.equal(drained.records.length, 1);
    assert.equal(drained.records[0]?.text, "boom");
  });

  test("a network event from a background tab reaches that tab's buffer", async () => {
    const { stub, session } = await twoTabSession();
    stub.emit({
      method: "Network.requestWillBeSent",
      sessionId: "s1",
      params: { requestId: "r1", request: { url: "https://one.test/api", method: "GET" }, type: "XHR" },
    });
    await flush();
    await session.switchTo("t1");
    const drained = session.drainNetworkBuffer({});
    assert.equal(drained.records.length, 1);
    assert.equal(drained.records[0]?.url, "https://one.test/api");
  });

  test("a background tab's dialog is recorded against that tab, not the active one", async () => {
    const { stub, session } = await twoTabSession();
    stub.emit({
      method: "Page.javascriptDialogOpening",
      sessionId: "s1",
      params: { type: "confirm", message: "really?" },
    });
    await flush();
    assert.equal(session.takeDialog(), null);
    await session.switchTo("t1");
    assert.equal(session.takeDialog()?.message, "really?");
  });

  test("a background tab's navigation marks that tab's page info dirty, not the active one", async () => {
    const { stub, session } = await twoTabSession();
    session.drainPageInfoInvalidations();
    stub.emit({ method: "Page.loadEventFired", sessionId: "s1", params: {} });
    await flush();
    assert.equal(session.drainPageInfoInvalidations(), false);
    await session.switchTo("t1");
    assert.equal(session.drainPageInfoInvalidations(), true);
  });

  test("an event from a session this instance never attached is ignored", async () => {
    const { stub, session } = await twoTabSession();
    stub.emit({
      method: "Runtime.consoleAPICalled",
      sessionId: "unknown-session",
      params: { type: "error", args: [{ type: "string", value: "stranger" }] },
    });
    await flush();
    assert.equal(session.drainConsoleBuffer({}).records.length, 0);
    await session.switchTo("t1");
    assert.equal(session.drainConsoleBuffer({}).records.length, 0);
  });
});
