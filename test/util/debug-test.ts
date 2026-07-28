import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { debugClicksEnabled, setDebugClicks } from "../../src/util/debug";

describe("debug click overlay switch", () => {
  afterEach(() => {
    setDebugClicks(false);
  });

  test("off when neither the flag nor the env var is set", () => {
    assert.equal(debugClicksEnabled({}), false);
  });

  test("the --browser-debug-clicks flag turns it on", () => {
    setDebugClicks(true);
    assert.equal(debugClicksEnabled({}), true);
  });

  test("BH_DEBUG_CLICKS still turns it on without the flag", () => {
    assert.equal(debugClicksEnabled({ BH_DEBUG_CLICKS: "1" }), true);
  });

  test("an empty BH_DEBUG_CLICKS does not turn it on", () => {
    assert.equal(debugClicksEnabled({ BH_DEBUG_CLICKS: "" }), false);
  });

  test("the flag can be turned back off", () => {
    setDebugClicks(true);
    setDebugClicks(false);
    assert.equal(debugClicksEnabled({}), false);
  });
});
