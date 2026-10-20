// Keeps the tool reference in skills/pi-browser-harness/SKILL.md in step with the registry.
//
//   npm run gen:skill            rewrite the generated block from ALL_TOOLS
//   npm run gen:skill -- --check exit 1 when the block is stale (what the test suite asserts)
//
// Only the text between the markers is generated; the hand-written guidance around it is left
// alone. Each row is the tool name, its concurrency lane and its promptSnippet, which is the
// one-line summary pi already shows the model.
import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { ALL_TOOLS } from "../src/registry";
import type { BrowserTool } from "../src/util/tool";
import { type Result, err, ok } from "../src/util/result";

export const TOOLS_START = "<!-- tools:start -->";
export const TOOLS_END = "<!-- tools:end -->";

export type SkillTool = Pick<BrowserTool, "name" | "concurrency" | "promptSnippet">;

export type SyncError = {
  readonly kind: "missing_markers";
  readonly message: string;
};

const cell = (text: string): string => text.replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();

export const renderToolReference = (tools: ReadonlyArray<SkillTool>): string => {
  const rows = [...tools]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((t) => `| \`${t.name}\` | ${t.concurrency} | ${cell(t.promptSnippet)} |`);
  return [
    TOOLS_START,
    "Generated from `src/registry.ts` by `npm run gen:skill`; do not edit by hand.",
    "",
    "| Tool | Lane | Summary |",
    "|---|---|---|",
    ...rows,
    TOOLS_END,
  ].join("\n");
};

export const syncSkill = (content: string, tools: ReadonlyArray<SkillTool>): Result<string, SyncError> => {
  const start = content.indexOf(TOOLS_START);
  const end = content.indexOf(TOOLS_END);
  if (start === -1 || end === -1 || end < start) {
    return err({
      kind: "missing_markers",
      message: `SKILL.md needs a ${TOOLS_START} … ${TOOLS_END} block to hold the tool reference`,
    });
  }
  const before = content.slice(0, start);
  const after = content.slice(end + TOOLS_END.length);
  return ok(`${before}${renderToolReference(tools)}${after}`);
};

export const SKILL_PATH = join(dirname(fileURLToPath(import.meta.url)), "..", "skills", "pi-browser-harness", "SKILL.md");

const main = (argv: ReadonlyArray<string>): number => {
  const check = argv.includes("--check");
  const current = readFileSync(SKILL_PATH, "utf8");
  const synced = syncSkill(current, ALL_TOOLS);
  if (!synced.success) {
    console.error(synced.error.message);
    return 1;
  }
  if (synced.data === current) {
    console.log("SKILL.md tool reference is up to date");
    return 0;
  }
  if (check) {
    console.error("SKILL.md tool reference is stale; run `npm run gen:skill`");
    return 1;
  }
  writeFileSync(SKILL_PATH, synced.data);
  console.log("SKILL.md tool reference regenerated");
  return 0;
};

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  process.exitCode = main(process.argv.slice(2));
}
