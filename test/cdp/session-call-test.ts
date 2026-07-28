import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { decodeResult } from "../../src/cdp/commands";
import { createCdpSession } from "../../src/cdp/session";
import type { CdpTransport } from "../../src/cdp/transport";
import type { CdpEvent } from "../../src/cdp/types";
import { type Result, ok, err } from "../../src/util/result";
import { type CdpError, cdpError } from "../../src/cdp/errors";

type RequestOpts = { readonly sessionId?: string | null; readonly timeoutMs?: number };
type RecordedCall = {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly opts: RequestOpts | undefined;
};

const makeStubTransport = (
  responses: Record<string, Result<unknown, CdpError>> = {},
): { transport: CdpTransport; calls: RecordedCall[] } => {
  const calls: RecordedCall[] = [];
  const transport: CdpTransport = {
    connect: () => Promise.resolve(ok(undefined)),
    close: () => Promise.resolve(),
    request: (method, params, opts) => {
      calls.push({ method, params, opts });
      return Promise.resolve(responses[method] ?? ok({}));
    },
    // No real events ever arrive, so the session's background consumer awaits forever — with no timers involved, it does not keep the process alive.
    events: (): AsyncIterable<CdpEvent> => (async function* (): AsyncGenerator<CdpEvent> {
      await new Promise<never>(() => {});
    })(),
    state: () => "open",
    onClose: () => () => {},
  };
  return { transport, calls };
};

describe("typed call decoding", () => {
  test("extra Chrome fields on a result are tolerated", () => {
    const r = decodeResult("Target.getTargetInfo", {
      targetInfo: { targetId: "t", type: "page", title: "T", url: "u", futureField: 1 },
    });
    assert.equal(r.success, true);
  });
});

describe("CdpSession.call / callOnTarget / callBrowser", () => {
  test("(a) a valid stub payload decodes to typed data", async () => {
    const { transport } = makeStubTransport({
      "Target.getTargetInfo": ok({ targetInfo: { targetId: "t1", type: "page", title: "T", url: "u" } }),
    });
    const session = createCdpSession(transport);
    const r = await session.call("Target.getTargetInfo", {});
    assert.equal(r.success, true);
    if (r.success) {
      const targetId: string = r.data.targetInfo.targetId;
      assert.equal(targetId, "t1");
    }
  });

  test("(b) a garbage stub payload becomes invalid_response, without throwing", async () => {
    const { transport } = makeStubTransport({
      "Target.getTargetInfo": ok({ targetInfo: { targetId: 42 } }),
    });
    const session = createCdpSession(transport);
    const r = await session.call("Target.getTargetInfo", {});
    assert.equal(r.success, false);
    if (!r.success) assert.equal(r.error.kind, "invalid_response");
  });

  test("(c) a transport-level error passes through with its original kind", async () => {
    const { transport } = makeStubTransport({
      "Target.getTargetInfo": err(cdpError("timeout", "socket dead", "Target.getTargetInfo")),
    });
    const session = createCdpSession(transport);
    const r = await session.call("Target.getTargetInfo", {});
    assert.equal(r.success, false);
    if (!r.success) {
      assert.equal(r.error.kind, "timeout");
      assert.equal(r.error.message, "socket dead");
    }
  });

  test("(d) call/callOnTarget/callBrowser route the session id correctly", async () => {
    const { transport, calls } = makeStubTransport({
      "Target.attachToTarget": ok({ sessionId: "session-xyz" }),
    });
    const session = createCdpSession(transport);

    const switched = await session.switchTo("target-1");
    assert.equal(switched.success, true);

    calls.length = 0;

    await session.call("Page.navigate", { url: "http://example.com" });
    await session.callOnTarget("Page.navigate", { url: "http://example.com" }, "explicit-sid");
    await session.callBrowser("Target.getTargets");

    const navigateCalls = calls.filter((c) => c.method === "Page.navigate");
    assert.equal(navigateCalls[0]?.opts?.sessionId, "session-xyz");
    assert.equal(navigateCalls[1]?.opts?.sessionId, "explicit-sid");

    const browserCall = calls.find((c) => c.method === "Target.getTargets");
    assert.equal(browserCall?.opts?.sessionId, null);
  });

  test("opts.timeoutMs reaches the transport only when provided (exactOptionalPropertyTypes)", async () => {
    const { transport, calls } = makeStubTransport();
    const session = createCdpSession(transport);

    await session.callBrowser("Target.getTargets", {}, { timeoutMs: 5_000 });
    const withTimeout = calls.find((c) => c.method === "Target.getTargets");
    assert.equal(withTimeout?.opts?.timeoutMs, 5_000);

    await session.callBrowser("Target.getTargets");
    const withoutTimeout = calls.filter((c) => c.method === "Target.getTargets")[1];
    // The key must be absent, not present-with-undefined — the distinction exactOptionalPropertyTypes enforces at the call site.
    assert.equal(withoutTimeout?.opts && "timeoutMs" in withoutTimeout.opts, false);
  });
});
