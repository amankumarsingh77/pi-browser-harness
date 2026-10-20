import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { describe, it } from "node:test";
import { ALL_TOOLS } from "../../src/registry";
import { SKILL_PATH, TOOLS_END, TOOLS_START, renderToolReference, syncSkill } from "../../scripts/gen-skill";

const skill = readFileSync(SKILL_PATH, "utf8");

describe("SKILL.md tool reference", () => {
  it("is up to date with the registry (run `npm run gen:skill` when this fails)", () => {
    const synced = syncSkill(skill, ALL_TOOLS);
    assert.ok(synced.success, "SKILL.md has lost its tools:start/tools:end markers");
    assert.equal(synced.data, skill, "SKILL.md tool reference is stale; run `npm run gen:skill`");
  });

  it("names every registered tool", () => {
    for (const tool of ALL_TOOLS) {
      assert.ok(skill.includes(`\`${tool.name}\``), `SKILL.md does not mention ${tool.name}`);
    }
  });

  it("only refers to real tools", () => {
    const names = new Set(ALL_TOOLS.map((t) => t.name));
    for (const token of skill.match(/\bbrowser_[a-z]+(?:_[a-z]+)*\b/g) ?? []) {
      assert.ok(names.has(token), `SKILL.md mentions unknown tool ${token}`);
    }
  });

  it("keeps the hand-written text outside the markers untouched", () => {
    const content = `intro\n${TOOLS_START}\nold rows\n${TOOLS_END}\noutro\n`;
    const synced = syncSkill(content, [{ name: "browser_x", concurrency: "parallel", promptSnippet: "Do x | fast" }]);
    assert.ok(synced.success);
    assert.ok(synced.data.startsWith("intro\n"));
    assert.ok(synced.data.endsWith("\noutro\n"));
    assert.match(synced.data, /\| `browser_x` \| parallel \| Do x \\\| fast \|/);
    assert.doesNotMatch(synced.data, /old rows/);
  });

  it("sorts rows by name so reordering the registry does not churn the file", () => {
    const a = renderToolReference([
      { name: "browser_b", concurrency: "parallel", promptSnippet: "b" },
      { name: "browser_a", concurrency: "serialized", promptSnippet: "a" },
    ]);
    const b = renderToolReference([
      { name: "browser_a", concurrency: "serialized", promptSnippet: "a" },
      { name: "browser_b", concurrency: "parallel", promptSnippet: "b" },
    ]);
    assert.equal(a, b);
    assert.ok(a.indexOf("browser_a") < a.indexOf("browser_b"));
  });

  it("reports missing markers instead of appending blindly", () => {
    const synced = syncSkill("no markers here", ALL_TOOLS);
    assert.ok(!synced.success);
    assert.equal(synced.error.kind, "missing_markers");
  });
});
