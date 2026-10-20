import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { renderedText, testTheme } from "./client-overrides";
import { setupTool } from "../../src/domains/setup";

// browser_setup's handler delegates to performSetup, which scans the host's processes for a running browser and
// spawns the daemon; neither is injectable, so only the tool's static contract is checked here.
describe("browser_setup contract", () => {
  test("runs without the alive check, in the parallel lane, under its registered name", () => {
    assert.equal(setupTool.name, "browser_setup");
    assert.equal(setupTool.ensureAlive, false);
    assert.equal(setupTool.concurrency, "parallel");
    assert.equal(setupTool.renderResult, undefined);
  });

  test("takes no arguments", () => {
    assert.deepEqual(Object.keys(setupTool.parameters.properties), []);
  });

  test("renders a fixed call line", () => {
    assert.ok(setupTool.renderCall);
    assert.equal(renderedText(setupTool.renderCall({}, testTheme)), "🔧 Initializing browser...");
  });

  test("tells the model to retry the failed tool afterwards", () => {
    assert.ok(setupTool.promptGuidelines.some((g) => g.includes("retry")));
    assert.match(setupTool.description, /Idempotent/);
  });
});
