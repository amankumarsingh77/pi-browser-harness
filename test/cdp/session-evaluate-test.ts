import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { evaluateJson } from "../../src/cdp/session";
import type { CdpSession } from "../../src/cdp/session";
import { err, ok } from "../../src/util/result";

const isNumberArray = (v: unknown): v is ReadonlyArray<number> =>
  Array.isArray(v) && v.every((x) => typeof x === "number");

const fakeSession = (payload: unknown): CdpSession =>
  ({
    call: async () => ok(payload),
  }) as unknown as CdpSession;

type Call = { method: string; args: unknown[] };

const recordingSession = (result: unknown): { session: CdpSession; calls: Call[] } => {
  const calls: Call[] = [];
  const session = {
    call: async (...args: unknown[]) => {
      calls.push({ method: "call", args });
      return result;
    },
    callOnTarget: async (...args: unknown[]) => {
      calls.push({ method: "callOnTarget", args });
      return result;
    },
  } as unknown as CdpSession;
  return { session, calls };
};

describe("evaluateJson", () => {
  test("unwraps result.value and applies the guard", async () => {
    const s = fakeSession({ result: { type: "object", value: [1, 2, 3] } });
    const r = await evaluateJson(s, "[1,2,3]", isNumberArray);
    assert.equal(r.success, true);
    if (r.success) assert.deepEqual(r.data, [1, 2, 3]);
  });

  test("surfaces a page exception as an error", async () => {
    const s = fakeSession({
      result: { type: "undefined" },
      exceptionDetails: { text: "ReferenceError: x is not defined" },
    });
    const r = await evaluateJson(s, "x", isNumberArray);
    assert.equal(r.success, false);
    if (!r.success) {
      assert.equal(r.error.kind, "remote_error");
      assert.match(r.error.message, /ReferenceError/);
    }
  });

  test("rejects a value that fails the guard", async () => {
    const s = fakeSession({ result: { type: "string", value: "nope" } });
    const r = await evaluateJson(s, "'nope'", isNumberArray);
    assert.equal(r.success, false);
    if (!r.success) assert.equal(r.error.kind, "invalid_response");
  });

  test("dispatches via callOnTarget when opts.sessionId is set", async () => {
    const { session, calls } = recordingSession(ok({ result: { type: "object", value: [4, 5] } }));
    const r = await evaluateJson(session, "[4,5]", isNumberArray, { sessionId: "sess-1" });
    assert.equal(r.success, true);
    if (r.success) assert.deepEqual(r.data, [4, 5]);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "callOnTarget");
    const [, , sessionIdArg] = calls[0]?.args ?? [];
    assert.equal(sessionIdArg, "sess-1");
  });

  test("dispatches via call when no opts are given", async () => {
    const { session, calls } = recordingSession(ok({ result: { type: "object", value: [1] } }));
    const r = await evaluateJson(session, "[1]", isNumberArray);
    assert.equal(r.success, true);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.method, "call");
    assert.equal(calls.some((c) => c.method === "callOnTarget"), false);
  });

  test("passes timeoutMs through to the transport options", async () => {
    const { session, calls } = recordingSession(ok({ result: { type: "object", value: [1] } }));
    await evaluateJson(session, "[1]", isNumberArray, { timeoutMs: 5000 });
    const [, , optsArg] = calls[0]?.args ?? [];
    assert.deepEqual(optsArg, { timeoutMs: 5000 });
  });

  test("passes through a transport failure unchanged", async () => {
    const failure = err({ kind: "timeout" as const, message: "timed out" });
    const { session } = recordingSession(failure);
    const r = await evaluateJson(session, "[1]", isNumberArray);
    assert.equal(r.success, false);
    if (!r.success) {
      assert.equal(r.error.kind, "timeout");
      assert.equal(r.error.message, "timed out");
    }
  });
});
