import { test, before, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join } from "node:path";

describe("web-search-researcher subagent config references only real tools", () => {
  let frontmatter: string;
  let body: string;
  let toolsLine: string;

  before(() => {
    const agentPath = join(import.meta.dirname, "..", "..", ".pi", "agents", "web-search-researcher.md");
    const raw = readFileSync(agentPath, "utf8");
    const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
    frontmatter = fmMatch ? (fmMatch[1] ?? "") : "";
    body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
    toolsLine = frontmatter.split("\n").find((l) => l.startsWith("tools:")) ?? "";
  });

  test("S20: tools includes browser_web_search", () => {
    assert.ok(toolsLine.includes("browser_web_search"));
  });

  test("S20: tools includes browser_read_page", () => {
    assert.ok(toolsLine.includes("browser_read_page"));
  });

  test("S20: tools does NOT include web_search", () => {
    assert.ok(!/\bweb_search\b/.test(toolsLine));
  });

  test("S20: tools does NOT include web_fetch", () => {
    assert.ok(!/\bweb_fetch\b/.test(toolsLine));
  });

  test("S20: isolated: true is present", () => {
    assert.ok(/^\s*isolated:\s*true\s*$/m.test(frontmatter));
  });

  test("S20: body has no WebSearch/WebFetch references", () => {
    assert.ok(!/WebSearch|WebFetch/.test(body));
  });
});
