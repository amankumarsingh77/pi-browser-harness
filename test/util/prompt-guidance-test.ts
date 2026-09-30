import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_TOOLS } from "../../src/registry";
import { getBrowserSystemPrompt } from "../../src/prompt";

const prompt = getBrowserSystemPrompt();
const names = new Set(ALL_TOOLS.map((tool) => tool.name));

const toolNamed = (name: string) => {
  const tool = ALL_TOOLS.find((item) => item.name === name);
  assert.ok(tool, `${name} must remain registered`);
  return tool;
};

describe("browser prompt guidance", () => {
  it("references only registered browser tools", () => {
    for (const name of prompt.match(/\bbrowser_[a-z]+(?:_[a-z]+)*\b/g) ?? []) {
      assert.ok(names.has(name), `Unknown tool in connected prompt: ${name}`);
    }
  });

  it("does not repeat identical guidelines across tools", () => {
    const seen = new Map<string, string>();
    for (const tool of ALL_TOOLS) {
      for (const guideline of tool.promptGuidelines) {
        assert.ok(!seen.has(guideline), `${tool.name} repeats a guideline from ${seen.get(guideline)}`);
        seen.set(guideline, tool.name);
      }
    }
  });

  it("preserves cross-tool recovery, verification, and tab isolation", () => {
    assert.match(prompt, /ref is stale/);
    assert.match(prompt, /browser_snapshot/);
    assert.match(prompt, /Page changes/);
    assert.match(prompt, /own(?:ed)?.*Chrome\s+window/);
    assert.match(prompt, /Close.*tabs/);
    assert.match(prompt, /serializ/);
    assert.match(prompt, /concurrent|parallel/);
    assert.match(prompt, /browser_current_tab/);
  });

  it("does not promise serialization or automatic diffs for scripts", () => {
    assert.equal(toolNamed("browser_run_script").concurrency, "parallel");
    const normalized = prompt.replaceAll("`", "").replace(/\s+/g, " ");
    assert.match(normalized, /browser_run_script bypasses that lane/);
    assert.match(normalized, /keep mutating scripts sequential with other browser calls/);
    assert.match(normalized, /Tools without a diff.*need explicit state verification/);
  });

  it("keeps shared guidance available before the browser connects", () => {
    const disconnected = getBrowserSystemPrompt(false);
    assert.match(disconnected, /browser_setup/);
    assert.match(disconnected, /\/browser-setup/);
    for (const rule of ["ref is stale", "Page changes", "owned Chrome window", "browser_current_tab"]) {
      assert.ok(disconnected.includes(rule), `Disconnected prompt lost: ${rule}`);
    }
    assert.doesNotMatch(prompt, /Browser is not connected/);
  });

  it("keeps script execution safeguards and return contract available", () => {
    const tool = toolNamed("browser_run_script");
    assert.match(tool.description, /tmpdir, cwd, or BH_SCRIPT_DIR/);
    assert.match(tool.description, /only invoke scripts you wrote and reviewed/);
    assert.match(tool.promptGuidelines.join("\n"), /MUST return.*content/);
  });

  it("keeps CAPTCHA recovery and header cleanup instructions available", () => {
    assert.match(toolNamed("browser_web_search").promptGuidelines.join("\n"), /CAPTCHA.*do not retry in a tight loop/);
    assert.match(toolNamed("browser_set_headers").promptGuidelines.join("\n"), /browser_clear_headers before switching tabs or navigating.*another origin/);
  });
});
