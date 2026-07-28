import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createCdpSession } from "../../src/cdp/session";
import { createOwnershipRegistry } from "../../src/cdp/ownership";
import { createStubTransport } from "../domains/fake-client";
import { ok } from "../../src/util/result";

const ENABLED_DOMAINS = ["Page", "DOM", "Runtime", "Network", "Accessibility", "Log"];

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
  return { stub, session };
};

const enablesFor = (stub: { calls: ReadonlyArray<{ method: string; sessionId: string | null | undefined }> }, sessionId: string): string[] =>
  stub.calls.filter((c) => c.sessionId === sessionId && c.method.endsWith(".enable")).map((c) => c.method);

describe("CdpSession.switchTo domain enablement", () => {
  test("a first visit enables every domain on the new session", async () => {
    const { stub, session } = await twoTabSession();
    const switched = await session.switchTo("t2");
    assert.equal(switched.success, true);
    assert.deepEqual(
      enablesFor(stub, "s2").sort(),
      ENABLED_DOMAINS.map((d) => `${d}.enable`).sort(),
    );
  });

  test("returning to a known tab re-enables domains on its new session", async () => {
    const { stub, session } = await twoTabSession();
    await session.switchTo("t2");
    const back = await session.switchTo("t1");
    assert.equal(back.success, true);
    assert.equal(session.current()?.sessionId, "s3");
    assert.deepEqual(
      enablesFor(stub, "s3").sort(),
      ENABLED_DOMAINS.map((d) => `${d}.enable`).sort(),
    );
  });

  test("calls on the returned-to tab are routed to its refreshed session id", async () => {
    const { stub, session } = await twoTabSession();
    await session.switchTo("t2");
    await session.switchTo("t1");
    const r = await session.call("Page.bringToFront", {});
    assert.equal(r.success, true);
    const last = stub.calls.at(-1);
    assert.equal(last?.method, "Page.bringToFront");
    assert.equal(last?.sessionId, "s3");
  });
});
