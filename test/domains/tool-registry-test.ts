import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import { ALL_TOOLS, type ToolRegistrar, createToolRegistry } from "../../src/registry";
import { type BrowserTool, defineBrowserTool } from "../../src/util/tool";
import { ok } from "../../src/util/result";
import { createFakeClient } from "./fake-client";

const probe = (name: string): BrowserTool =>
  defineBrowserTool({
    name,
    label: name,
    description: `${name} description`,
    promptSnippet: `${name} snippet`,
    promptGuidelines: [],
    parameters: Type.Object({}),
    concurrency: "parallel",
    ensureAlive: false,
    handler: () => Promise.resolve(ok({ text: "done" })),
  });

type Sink = ToolRegistrar & { readonly names: ReadonlyArray<string> };

const sink = (): Sink => {
  const names: string[] = [];
  return {
    names,
    registerTool: (td) => {
      names.push(td.name);
    },
  };
};

describe("createToolRegistry", () => {
  it("starts with the built-in tools", () => {
    const registry = createToolRegistry();
    assert.deepEqual(
      registry.tools().map((t) => t.name),
      ALL_TOOLS.map((t) => t.name),
    );
  });

  it("rejects a tool whose name is already taken, with a clear message", () => {
    const registry = createToolRegistry([probe("browser_one")]);
    const result = registry.add(probe("browser_one"));
    assert.ok(!result.success);
    assert.equal(result.error.kind, "duplicate_name");
    assert.match(result.error.message, /"browser_one" is already registered/);
    assert.equal(registry.tools().length, 1);
  });

  it("rejects shadowing a built-in", () => {
    const registry = createToolRegistry();
    const result = registry.add(probe("browser_click"));
    assert.ok(!result.success);
    assert.equal(registry.tools().length, ALL_TOOLS.length);
  });

  it("refuses to be built from a list with duplicate names", () => {
    assert.throws(() => createToolRegistry([probe("browser_dup"), probe("browser_dup")]), /"browser_dup" is already registered/);
  });

  it("registers built-ins and contributed tools with pi, in insertion order", async () => {
    const registry = createToolRegistry([probe("browser_one")]);
    assert.ok(registry.add(probe("browser_two")).success);
    const pi = sink();
    registry.register(pi, (await createFakeClient()).client);
    assert.deepEqual(pi.names, ["browser_one", "browser_two"]);
  });

  it("registers each tool with pi only once, picking up late additions on the next call", async () => {
    const registry = createToolRegistry([probe("browser_one")]);
    const client = (await createFakeClient()).client;
    const pi = sink();
    registry.register(pi, client);
    registry.register(pi, client);
    assert.deepEqual(pi.names, ["browser_one"]);

    assert.ok(registry.add(probe("browser_late")).success);
    registry.register(pi, client);
    assert.deepEqual(pi.names, ["browser_one", "browser_late"]);
  });

  it("hands out a copy so callers cannot mutate the registry through tools()", () => {
    const registry = createToolRegistry([probe("browser_one")]);
    const before = registry.tools();
    assert.ok(registry.add(probe("browser_two")).success);
    assert.equal(before.length, 1);
    assert.equal(registry.tools().length, 2);
  });
});
