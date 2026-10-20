import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { ALL_TOOLS } from "../../src/registry";
import { type PromptTool, getBrowserSystemPrompt, laneNames, shortToolName } from "../../src/prompt";

// Pulls the comma-separated short names out of "serialized lane (a, b, c)" / "parallel lane (x, y)".
const listedAfter = (prompt: string, label: string): ReadonlyArray<string> => {
  const normalized = prompt.replace(/\s+/g, " ");
  const match = new RegExp(`${label} \\(([^)]*)\\)`).exec(normalized);
  assert.ok(match?.[1] !== undefined, `prompt has no "${label} (...)" list`);
  return match[1].split(",").map((s) => s.trim()).filter((s) => s.length > 0);
};

const sorted = (names: ReadonlyArray<string>): ReadonlyArray<string> => [...names].sort();

describe("browser prompt lanes are derived from the registry", () => {
  it("lists exactly the parallel tools from ALL_TOOLS and no others", () => {
    const expected = ALL_TOOLS.filter((t) => t.concurrency === "parallel").map((t) => shortToolName(t.name));
    assert.deepEqual(sorted(listedAfter(getBrowserSystemPrompt(), "parallel lane")), sorted(expected));
  });

  it("lists exactly the serialized tools from ALL_TOOLS and no others", () => {
    const expected = ALL_TOOLS.filter((t) => t.concurrency === "serialized").map((t) => shortToolName(t.name));
    assert.deepEqual(sorted(listedAfter(getBrowserSystemPrompt(), "serialized lane")), sorted(expected));
  });

  it("names every registered tool in exactly one lane", () => {
    const prompt = getBrowserSystemPrompt();
    const serialized = new Set(listedAfter(prompt, "serialized lane"));
    const parallel = new Set(listedAfter(prompt, "parallel lane"));
    for (const tool of ALL_TOOLS) {
      const short = shortToolName(tool.name);
      assert.notEqual(serialized.has(short), parallel.has(short), `${tool.name} must be in exactly one lane`);
    }
  });

  it("follows a custom tool list instead of the registry", () => {
    const tools: ReadonlyArray<PromptTool> = [
      { name: "browser_alpha", concurrency: "serialized" },
      { name: "browser_beta", concurrency: "parallel" },
      { name: "custom_gamma", concurrency: "parallel" },
    ];
    const prompt = getBrowserSystemPrompt(true, tools);
    assert.deepEqual(listedAfter(prompt, "serialized lane"), ["alpha"]);
    assert.deepEqual(listedAfter(prompt, "parallel lane"), ["beta", "custom_gamma"]);
    assert.deepEqual(laneNames(tools), {
      serialized: ["browser_alpha"],
      parallel: ["browser_beta", "custom_gamma"],
    });
  });

  it("keeps the disconnected prompt's lanes identical to the connected one", () => {
    const connected = getBrowserSystemPrompt(true);
    const disconnected = getBrowserSystemPrompt(false);
    for (const label of ["serialized lane", "parallel lane"]) {
      assert.deepEqual(listedAfter(disconnected, label), listedAfter(connected, label));
    }
  });
});
