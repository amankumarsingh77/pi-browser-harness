/**
 * S20: the web-search-researcher subagent config references only real tools.
 *
 * Guards against the pre-Phase-3 regression where the agent named the
 * non-existent web_search / web_fetch tools. Pure string checks over the
 * markdown file — no browser, no subagent runtime.
 *
 * Run: npx tsx test/deep-research/agent-config-test.ts
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string): void => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
};

const agentPath = join(import.meta.dirname, "..", "..", ".pi", "agents", "web-search-researcher.md");
const raw = readFileSync(agentPath, "utf8");

const fmMatch = raw.match(/^---\n([\s\S]*?)\n---/);
const frontmatter = fmMatch ? (fmMatch[1] ?? "") : "";
const body = fmMatch ? raw.slice(fmMatch[0].length) : raw;
const toolsLine = frontmatter.split("\n").find((l) => l.startsWith("tools:")) ?? "";

// S20
check(toolsLine.includes("browser_web_search"), "S20: tools includes browser_web_search");
check(toolsLine.includes("browser_read_page"), "S20: tools includes browser_read_page");
check(!/\bweb_search\b/.test(toolsLine), "S20: tools does NOT include web_search");
check(!/\bweb_fetch\b/.test(toolsLine), "S20: tools does NOT include web_fetch");
check(/^\s*isolated:\s*true\s*$/m.test(frontmatter), "S20: isolated: true is present");
check(!/WebSearch|WebFetch/.test(body), "S20: body has no WebSearch/WebFetch references");

console.log(`\n${passed} passed, ${failed} failed`);
if (failed > 0) process.exit(1);
