import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { ALL_TOOLS, type ToolRegistrar } from "../../src/registry";
import { type BrowserTool, type ToolConcurrency, defineBrowserTool } from "../../src/util/tool";
import type { BrowserClient } from "../../src/client";
import { ok } from "../../src/util/result";

const SERIALIZED = new Set([
  "browser_click",
  "browser_type",
  "browser_fill",
  "browser_fill_form",
  "browser_set_checked",
  "browser_select_option",
  "browser_focus",
  "browser_press_key",
  "browser_dispatch_key",
  "browser_scroll",
  "browser_wait_for_load",
  "browser_handle_dialog",
  "browser_navigate",
  "browser_open_urls",
  "browser_go_back",
  "browser_go_forward",
  "browser_reload",
  "browser_switch_tab",
  "browser_new_tab",
  "browser_close_tab",
  "browser_upload_file",
  "browser_download",
  "browser_print_to_pdf",
  "browser_viewport_resize",
  "browser_drag_and_drop",
  "browser_set_headers",
  "browser_clear_headers",
  "browser_web_search",
]);

describe("tool registry", () => {
  test("every tool declares a concurrency class", () => {
    const lanes: ReadonlySet<string> = new Set(["serialized", "parallel"]);
    for (const t of ALL_TOOLS) {
      assert.ok(lanes.has(t.concurrency), `${t.name} has no concurrency class`);
    }
  });

  test("the serialized set is exactly the mutating tools", () => {
    const actual = new Set(
      ALL_TOOLS.filter((t) => t.concurrency === "serialized").map((t) => t.name),
    );
    assert.deepEqual([...actual].sort(), [...SERIALIZED].sort());
  });

  test("tool names are unique", () => {
    const names = ALL_TOOLS.map((t) => t.name);
    assert.equal(new Set(names).size, names.length);
  });

  test("every tool name uses the browser_ prefix", () => {
    for (const t of ALL_TOOLS) assert.match(t.name, /^browser_/);
  });
});

type LockProbe = {
  readonly acquires: ReadonlyArray<string>;
  run: (tool: BrowserTool) => Promise<void>;
};

const lockProbe = (): LockProbe => {
  const acquires: string[] = [];
  const release = (): void => undefined;
  const mutex = {
    mutationMutex: () => ({
      acquire: () => {
        acquires.push("acquired");
        return Promise.resolve(release);
      },
    }),
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only mutationMutex is reached with ensureAlive:false
  const client = mutex as unknown as BrowserClient;
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the probe handler never reads its context
  const extensionCtx = undefined as unknown as ExtensionContext;
  return {
    acquires,
    run: async (tool) => {
      let registered: ToolDefinition | undefined;
      const sink = {
        registerTool: (td: ToolDefinition) => {
          registered = td;
        },
      };
      // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- pi's registerTool is generic over the schema; a sink typed for one schema needs the same erasure pi itself does
      const pi = sink as unknown as ToolRegistrar;
      tool.register(pi, client);
      assert.ok(registered, "tool was not registered");
      await registered.execute("id", {}, undefined, undefined, extensionCtx);
    },
  };
};

const probeTool = (concurrency: ToolConcurrency): BrowserTool =>
  defineBrowserTool({
    name: "browser_probe",
    label: "Probe",
    description: "probe",
    promptSnippet: "probe",
    promptGuidelines: [],
    parameters: Type.Object({}),
    ensureAlive: false,
    concurrency,
    handler: () => Promise.resolve(ok({ text: "done" })),
  });

describe("concurrency lane selection", () => {
  test("a parallel tool skips the mutation mutex", async () => {
    const probe = lockProbe();
    await probe.run(probeTool("parallel"));
    assert.deepEqual([...probe.acquires], []);
  });

  test("a serialized tool takes the mutation mutex", async () => {
    const probe = lockProbe();
    await probe.run(probeTool("serialized"));
    assert.deepEqual([...probe.acquires], ["acquired"]);
  });
});
