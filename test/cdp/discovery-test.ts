import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { endpointFromEnv } from "../../src/cdp/discovery";

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
