import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  CDP_COMMAND_TIMEOUT_MAX_MS,
  CDP_COMMAND_TIMEOUT_MS,
  CONTROL_ACTIONS,
  commandTimeoutFor,
  deserialize,
  serialize,
  type WireMessage,
} from "../../src/daemon/protocol";

const roundTrip = (msg: WireMessage): WireMessage | null => deserialize(serialize(msg));

const parse = (v: unknown): WireMessage | null => deserialize(JSON.stringify(v));

describe("daemon wire protocol guard", () => {
  test("every control action round-trips with exactly its own fields", () => {
    assert.deepEqual(CONTROL_ACTIONS, ["register", "registered", "deregister", "shutdown"]);
    assert.deepEqual(roundTrip({ type: "control", action: "register", clientId: "c" }), { type: "control", action: "register", clientId: "c" });
    assert.deepEqual(roundTrip({ type: "control", action: "registered", clientId: "c" }), { type: "control", action: "registered", clientId: "c" });
    assert.deepEqual(roundTrip({ type: "control", action: "deregister", clientId: "c" }), { type: "control", action: "deregister", clientId: "c" });
    assert.deepEqual(roundTrip({ type: "control", action: "shutdown" }), { type: "control", action: "shutdown" });
    assert.deepEqual(roundTrip({ type: "control", action: "shutdown", reason: "idle" }), { type: "control", action: "shutdown", reason: "idle" });
  });

  test("a control message missing or mistyping its clientId is rejected", () => {
    assert.equal(parse({ type: "control", action: "register" }), null);
    assert.equal(parse({ type: "control", action: "registered", clientId: 7 }), null);
    assert.equal(parse({ type: "control", action: "deregister", clientId: null }), null);
  });

  test("an unknown control action is rejected", () => {
    assert.equal(parse({ type: "control", action: "reboot", clientId: "c" }), null);
    assert.equal(parse({ type: "control", action: 3 }), null);
  });

  test("a shutdown with a non-string reason is rejected", () => {
    assert.equal(parse({ type: "control", action: "shutdown", reason: { code: 1 } }), null);
  });

  test("a request or event whose params is not an object never reaches Chrome", () => {
    assert.equal(parse({ type: "request", id: 1, method: "Runtime.enable", params: "oops" }), null);
    assert.equal(parse({ type: "request", id: 1, method: "Runtime.enable", params: [1, 2] }), null);
    assert.equal(parse({ type: "event", method: "Page.loadEventFired", params: 42 }), null);
    assert.deepEqual(parse({ type: "request", id: 1, method: "Runtime.enable" }), { type: "request", id: 1, method: "Runtime.enable" });
    assert.deepEqual(
      parse({ type: "request", id: 1, method: "Runtime.enable", params: { a: 1 }, sessionId: "S" }),
      { type: "request", id: 1, method: "Runtime.enable", params: { a: 1 }, sessionId: "S" },
    );
  });

  test("a response error must carry a numeric code and a string message", () => {
    assert.equal(parse({ type: "response", id: 1, error: { message: "x" } }), null);
    assert.equal(parse({ type: "response", id: 1, error: { code: "1", message: "x" } }), null);
    assert.equal(parse({ type: "response", id: 1, error: { code: 1, message: "x", data: 5 } }), null);
    assert.deepEqual(parse({ type: "response", id: 1, error: { code: 1, message: "x" } }), { type: "response", id: 1, error: { code: 1, message: "x" } });
    assert.deepEqual(parse({ type: "response", id: 1, result: null }), { type: "response", id: 1, result: null });
  });

  test("malformed input is rejected rather than thrown", () => {
    assert.equal(deserialize("not json"), null);
    assert.equal(deserialize("[]"), null);
    assert.equal(deserialize("null"), null);
    assert.equal(parse({ type: "mystery" }), null);
    assert.equal(parse({ type: "request", id: "1", method: "m" }), null);
  });
});

describe("per-request command timeout", () => {
  test("a request may lengthen the daemon's wait, up to the cap, but never shorten it", () => {
    assert.equal(commandTimeoutFor({}), CDP_COMMAND_TIMEOUT_MS);
    assert.equal(commandTimeoutFor({ timeoutMs: 2_000 }), CDP_COMMAND_TIMEOUT_MS);
    assert.equal(commandTimeoutFor({ timeoutMs: 45_000 }), 45_000);
    assert.equal(commandTimeoutFor({ timeoutMs: 10_000_000 }), CDP_COMMAND_TIMEOUT_MAX_MS);
  });

  test("timeoutMs survives the wire, and a non-number is rejected", () => {
    assert.deepEqual(roundTrip({ type: "request", id: 1, method: "Runtime.evaluate", timeoutMs: 45_000 }), {
      type: "request", id: 1, method: "Runtime.evaluate", timeoutMs: 45_000,
    });
    assert.equal(parse({ type: "request", id: 1, method: "Runtime.evaluate", timeoutMs: "soon" }), null);
  });
});
