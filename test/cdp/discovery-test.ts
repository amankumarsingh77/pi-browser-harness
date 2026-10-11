import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { endpointFromEnv, parseVersionResponse } from "../../src/cdp/discovery";

describe("BU_CDP_WS endpoint override", () => {
  test("an unset variable leaves discovery to run normally", () => {
    assert.equal(endpointFromEnv({}), undefined);
  });

  test("a set variable becomes the endpoint", () => {
    const e = endpointFromEnv({ BU_CDP_WS: "ws://127.0.0.1:9333/devtools/browser/abc" });
    assert.equal(e?.wsUrl, "ws://127.0.0.1:9333/devtools/browser/abc");
  });

  test("no userDataDir is claimed for a remote endpoint", () => {
    const e = endpointFromEnv({ BU_CDP_WS: "ws://example.test/x" });
    assert.equal(e?.userDataDir, undefined);
  });

  test("surrounding whitespace is trimmed", () => {
    const e = endpointFromEnv({ BU_CDP_WS: "  ws://127.0.0.1:9222/x  " });
    assert.equal(e?.wsUrl, "ws://127.0.0.1:9222/x");
  });

  test("an empty or whitespace-only variable is ignored, not treated as an endpoint", () => {
    assert.equal(endpointFromEnv({ BU_CDP_WS: "" }), undefined);
    assert.equal(endpointFromEnv({ BU_CDP_WS: "   " }), undefined);
  });
});

describe("/json/version parsing", () => {
  test("extracts webSocketDebuggerUrl from a well-formed response", () => {
    const raw = JSON.stringify({ Browser: "Chrome/154.0", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" });
    assert.equal(parseVersionResponse(raw), "ws://127.0.0.1:9222/devtools/browser/abc");
  });

  test("a response without the url yields null", () => {
    assert.equal(parseVersionResponse(JSON.stringify({ Browser: "Chrome/154.0" })), null);
  });

  test("a non-string url, a non-object body, and invalid JSON all yield null", () => {
    assert.equal(parseVersionResponse(JSON.stringify({ webSocketDebuggerUrl: 42 })), null);
    assert.equal(parseVersionResponse(JSON.stringify([1, 2])), null);
    assert.equal(parseVersionResponse("not json"), null);
  });
});
