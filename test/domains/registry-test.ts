import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "typebox";
import { ALL_TOOLS } from "../../src/registry";
import { type AnyBrowserToolDefinition, registerBrowserTool } from "../../src/util/tool";
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
  "browser_web_search",
]);

describe("tool registry", () => {
  test("every tool declares a concurrency class", () => {
    for (const t of ALL_TOOLS) {
      assert.ok(
        t.concurrency === "serialized" || t.concurrency === "parallel",
        `${t.name} has no concurrency class`,
      );
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
  run: (def: AnyBrowserToolDefinition) => Promise<void>;
};

const lockProbe = (): LockProbe => {
  const acquires: string[] = [];
  const client = {
    mutationMutex: () => ({
      acquire: async () => {
        acquires.push("acquired");
        return () => {};
      },
    }),
  } as unknown as BrowserClient;
  return {
    acquires,
    run: async (def) => {
      let registered: ToolDefinition<TSchema> | undefined;
      const pi = {
        registerTool: (td: ToolDefinition<TSchema>) => {
          registered = td;
        },
      } as unknown as ExtensionAPI;
      registerBrowserTool(pi, client, def);
      assert.ok(registered, "tool was not registered");
      await registered.execute?.("id", {}, undefined, undefined, undefined as never);
    },
  };
};

const probeTool = (concurrency: unknown): AnyBrowserToolDefinition =>
  ({
    name: "browser_probe",
    label: "Probe",
    description: "probe",
    promptSnippet: "probe",
    promptGuidelines: [],
    parameters: Type.Object({}),
    ensureAlive: false,
    concurrency,
    handler: async () => ok({ text: "done" }),
  }) as AnyBrowserToolDefinition;

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

  test("a definition with no concurrency class takes the mutation mutex", async () => {
    const probe = lockProbe();
    await probe.run(probeTool(undefined));
    assert.deepEqual([...probe.acquires], ["acquired"]);
  });
});
