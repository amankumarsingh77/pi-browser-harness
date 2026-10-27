import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import browserHarnessExtension, { browserTools, defineBrowserTool, ok, registerBrowserTools } from "../../src/index";
import { ALL_TOOLS } from "../../src/registry";

const probe = (name: string) =>
  defineBrowserTool({
    name,
    label: name,
    description: `${name} description`,
    promptSnippet: `${name} snippet`,
    promptGuidelines: [],
    parameters: Type.Object({ note: Type.Optional(Type.String()) }),
    concurrency: "parallel",
    ensureAlive: false,
    handler: () => Promise.resolve(ok({ text: `${name} ran` })),
  });

type SessionStartHandler = (event: { type: "session_start" }, ctx: ExtensionContext) => Promise<unknown>;

type FakePi = {
  readonly pi: ExtensionAPI;
  readonly registered: ReadonlyArray<string>;
  readonly startSession: () => Promise<void>;
};

// Only the surface the extension touches between load and the end of session_start. pi's
// ExtensionAPI is far wider, so the fake is erased the same way every other test fake is.
const fakePi = (): FakePi => {
  const registered: string[] = [];
  let onSessionStart: SessionStartHandler | undefined;
  const shape = {
    registerFlag: () => undefined,
    registerCommand: () => undefined,
    registerTool: (td: ToolDefinition) => {
      registered.push(td.name);
    },
    getFlag: () => undefined,
    appendEntry: () => undefined,
    on: (event: string, handler: SessionStartHandler) => {
      if (event === "session_start") onSessionStart = handler;
    },
  };
  const ctxShape = { sessionManager: { getBranch: () => [], getSessionId: () => "registration-test" } };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial fake of pi's wide API
  const pi = shape as unknown as ExtensionAPI;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only getBranch and getSessionId are read during session_start
  const ctx = ctxShape as unknown as ExtensionContext;
  return {
    pi,
    registered,
    startSession: async () => {
      assert.ok(onSessionStart, "extension did not subscribe to session_start");
      await onSessionStart({ type: "session_start" }, ctx);
    },
  };
};

describe("registerBrowserTools (third-party registration seam)", () => {
  it("adds contributed tools next to the built-ins", () => {
    const result = registerBrowserTools([probe("browser_ext_alpha")]);
    assert.ok(result.success);
    const names = browserTools().map((t) => t.name);
    assert.ok(names.includes("browser_ext_alpha"));
    for (const tool of ALL_TOOLS) assert.ok(names.includes(tool.name));
  });

  it("rejects a clash with a built-in and leaves the registry untouched", () => {
    const before = browserTools().length;
    const result = registerBrowserTools([probe("browser_ext_beta"), probe("browser_click")]);
    assert.ok(!result.success);
    assert.equal(result.error.kind, "duplicate_name");
    assert.match(result.error.message, /"browser_click" is already registered/);
    assert.equal(browserTools().length, before);
    assert.ok(!browserTools().some((t) => t.name === "browser_ext_beta"));
  });

  it("rejects a clash inside the batch itself", () => {
    const before = browserTools().length;
    const result = registerBrowserTools([probe("browser_ext_gamma"), probe("browser_ext_gamma")]);
    assert.ok(!result.success);
    assert.equal(browserTools().length, before);
  });

  it("rejects re-registering a tool already contributed", () => {
    assert.ok(registerBrowserTools([probe("browser_ext_delta")]).success);
    const again = registerBrowserTools([probe("browser_ext_delta")]);
    assert.ok(!again.success);
  });

  it("registers contributed tools with pi on session_start, alongside the built-ins", async () => {
    assert.ok(registerBrowserTools([probe("browser_ext_epsilon")]).success);
    const fake = fakePi();
    browserHarnessExtension(fake.pi);
    await fake.startSession();
    assert.ok(fake.registered.includes("browser_ext_epsilon"));
    for (const tool of ALL_TOOLS) assert.ok(fake.registered.includes(tool.name), `${tool.name} not registered`);
    assert.equal(new Set(fake.registered).size, fake.registered.length, "a tool was registered twice");
  });
});
