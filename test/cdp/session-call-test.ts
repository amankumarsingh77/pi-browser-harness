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

/**
 * A stub transport: no socket, no browser. `request()` looks up a canned
 * Result by method name (defaulting to `ok({})` for methods the test doesn't
 * care about — e.g. the six domain-enable calls switchTo fires as a side
 * effect). Every call is recorded so tests can assert on exactly what the
 * session sent, including the sessionId routing and the timeoutMs option.
 */
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
    // No real events ever arrive; the session's background consumer just
    // awaits forever. No timers involved, so it doesn't keep the process alive.
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
      // Must stay "timeout" — decodeResult must never run on a failed
      // transport call and relabel it "invalid_response".
      assert.equal(r.error.kind, "timeout");
      assert.equal(r.error.message, "socket dead");
    }
  });

  test("(d) call/callOnTarget/callBrowser route the session id correctly", async () => {
    const { transport, calls } = makeStubTransport({
      "Target.attachToTarget": ok({ sessionId: "session-xyz" }),
    });
    const session = createCdpSession(transport);

    // Establish an internal sessionId distinct from both null and the
    // explicit sid used below, via the public switchTo() — no attachFirstPage
    // bookkeeping required.
    const switched = await session.switchTo("target-1");
    assert.equal(switched.success, true);

    calls.length = 0; // discard switchTo's own requests (activate/attach/enable*6)

    await session.call("Page.navigate", { url: "http://example.com" });
    await session.callOnTarget("Page.navigate", { url: "http://example.com" }, "explicit-sid");
    await session.callBrowser("Target.getTargets");

    const navigateCalls = calls.filter((c) => c.method === "Page.navigate");
    assert.equal(navigateCalls[0]?.opts?.sessionId, "session-xyz"); // call() uses the active session
    assert.equal(navigateCalls[1]?.opts?.sessionId, "explicit-sid"); // callOnTarget() uses the given sid, not the active one

    const browserCall = calls.find((c) => c.method === "Target.getTargets");
    assert.equal(browserCall?.opts?.sessionId, null); // callBrowser() forces null even though a session is active
  });

  test("opts.timeoutMs reaches the transport only when provided (exactOptionalPropertyTypes)", async () => {
    const { transport, calls } = makeStubTransport();
    const session = createCdpSession(transport);

    await session.callBrowser("Target.getTargets", {}, { timeoutMs: 5_000 });
    const withTimeout = calls.find((c) => c.method === "Target.getTargets");
    assert.equal(withTimeout?.opts?.timeoutMs, 5_000);

    await session.callBrowser("Target.getTargets");
    const withoutTimeout = calls.filter((c) => c.method === "Target.getTargets")[1];
    // The key itself must be absent, not present-with-undefined — that's the
    // distinction exactOptionalPropertyTypes exists to enforce at the call site.
    assert.equal(withoutTimeout?.opts && "timeoutMs" in withoutTimeout.opts, false);
  });
});
