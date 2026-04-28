/**
 * dynamic-tools.ts — self-writing tools for pi-browser-harness.
 *
 * Mirrors the browser-harness philosophy: the agent writes what's missing,
 * mid-task. No framework, no recipes, no rails.
 *
 * Provides three management tools:
 *   list_dynamic_tools  — see what's already registered
 *   register_tool       — inject a new tool into the harness
 *   remove_tool         — retire a tool that's no longer needed
 *
 * Tools registered via register_tool (which internally calls pi.registerTool())
 * are available immediately in the same session — the LLM can call them on
 * the very next sub-turn within the same agent processing cycle, without
 * needing /reload. The agent decides to extend the harness the same way
 * it decides to write any code: it sees a gap and fills it.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "typebox";
import type { BrowserDaemon } from "./daemon";

// ── Types ────────────────────────────────────────────────────────────────────

interface DynamicToolDef {
  name: string;
  label: string;
  description: string;
  execute: (params: Record<string, unknown>, signal: AbortSignal | undefined, onUpdate: ((update: unknown) => void) | undefined, ctx: unknown) => Promise<{ content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> | undefined }>;
}

// ── AsyncFunction constructor ────────────────────────────────────────────────

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

// ── Registration ─────────────────────────────────────────────────────────────

export function registerDynamicTools(pi: ExtensionAPI, daemon: BrowserDaemon): void {
  const registry = new Map<string, DynamicToolDef>();

  // ═══════════════════════════════════════════════════════════════════════════
  // list_dynamic_tools
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "list_dynamic_tools",
    label: "List Dynamic Tools",
    description:
      "List all dynamically registered tools with their names, labels, and descriptions. " +
      "Call this FIRST when you're unsure whether a needed capability already exists — " +
      "before writing a new tool.",
    promptSnippet: "List all dynamically registered tools (names + descriptions)",
    promptGuidelines: [
      "Call list_dynamic_tools before register_tool to avoid duplicating existing capabilities.",
      "If a needed tool exists but has the wrong shape, use remove_tool to replace it with a corrected version.",
    ],
    parameters: Type.Object({}),
    async execute() {
      if (registry.size === 0) {
        return {
          content: [{
            type: "text" as const,
            text: "No dynamic tools registered yet. The harness is clean — use register_tool to teach it something new.",
          }],
          details: { tools: [], count: 0 },
        };
      }

      const tools = Array.from(registry.values()).map((t) => ({
        name: t.name,
        label: t.label,
        description: t.description,
      }));

      return {
        content: [{
          type: "text" as const,
          text: `${tools.length} dynamic tool(s) registered:\n\n` +
            tools.map((t) => `• ${t.name} — ${t.description}`).join("\n"),
        }],
        details: { tools, count: tools.length },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // register_tool
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "register_tool",
    label: "Register Dynamic Tool",
    description:
      "Register a new tool by providing its JavaScript implementation. " +
      "The tool becomes available immediately in the same session — " +
      "the LLM can call it on the very next sub-turn within the same " +
      "agent processing cycle, without reloading. " +
      "Use this whenever you discover you need a capability the harness doesn't " +
      "already have. Don't work around limitations, extend the harness.\n\n" +
      "The implementation runs as an async function body. It receives these bindings:\n" +
      "  params    — the tool's arguments (as passed by the caller)\n" +
      "  daemon    — the browser daemon (for composing browser actions: daemon.cdp(), daemon.evaluateJS(), daemon.getPageInfo(), etc.)\n" +
      "  require   — Node.js require() for builtins and installed packages\n" +
      "  signal    — AbortSignal for cancellation\n" +
      "  onUpdate  — progress callback: onUpdate({ content: [{ type: 'text', text: '...' }] })\n" +
      "  ctx       — ExtensionContext with cwd, sessionManager, ui, signal, etc.\n" +
      "  console, fetch, JSON, Buffer, setTimeout, clearTimeout\n\n" +
      "The implementation MUST return { content: [{ type: 'text', text: '...' }], details?: {...} }.\n" +
      "For errors, throw: throw new Error('something went wrong').\n\n" +
      "Example implementation:\n" +
      '  const info = await daemon.getPageInfo();\n' +
      '  if ("dialog" in info) throw new Error("Dialog is blocking the page");\n' +
      '  return { content: [{ type: "text", text: `Current URL: ${info.url}` }], details: { url: info.url } };',
    promptSnippet: "Register a new tool with custom JavaScript logic (available immediately, next sub-turn)",
    promptGuidelines: [
      "Use register_tool when you need a capability not provided by the built-in browser_* tools. The new tool is available immediately — the LLM can call it on the very next sub-turn within the same agent processing cycle, without reloading.",
      "Before registering, always call list_dynamic_tools to check if a suitable tool already exists.",
      "The implementation has access to the browser daemon via `daemon` — use daemon.cdp(), daemon.evaluateJS(), daemon.getPageInfo(), etc. to compose browser actions inside the tool.",
      "For pure data processing or file operations, use require() to access Node.js modules like fs, path, crypto.",
      "If the implementation needs existing browser tools (browser_navigate, browser_screenshot, etc.), break those into separate tool calls before or after the dynamic tool — do not try to invoke them from within the implementation.",
    ],
    parameters: Type.Object({
      name: Type.String({
        description: "Unique tool name in snake_case (e.g. 'scrape_paginated_results', 'extract_structured_data')",
      }),
      label: Type.String({
        description: "Human-readable label for the tool (e.g. 'Scrape Paginated Results')",
      }),
      description: Type.String({
        description: "What the tool does, including expected parameter names and their types. This is shown to the LLM when it considers which tool to call.",
      }),
      implementation: Type.String({
        description:
          "JavaScript code (async function body). Bindings: params, daemon, require, signal, onUpdate, ctx, console, fetch, JSON, Buffer, setTimeout, clearTimeout. Must return { content: [{ type: 'text', text: '...' }], details?: {...} }.",
      }),
    }),
    async execute(_id, p, _signal, _onUpdate) {
      const { name, label, description, implementation } = p as {
        name: string;
        label: string;
        description: string;
        implementation: string;
      };

      // ── Validation ──────────────────────────────────────────────────
      if (!/^[a-z][a-z0-9_]*$/.test(name)) {
        return {
          content: [{
            type: "text" as const,
            text: `Invalid tool name '${name}'. Must be snake_case: lowercase letters, digits, and underscores, starting with a letter.`,
          }],
          details: { error: "invalid_name" },
        };
      }

      if (registry.has(name)) {
        const existing = registry.get(name)!;
        return {
          content: [{
            type: "text" as const,
            text: `Tool '${name}' already exists: ${existing.description}\n\nUse remove_tool("${name}") first if you want to replace it, then call register_tool again.`,
          }],
          details: { exists: true, existingLabel: existing.label },
        };
      }

      // ── Compile ─────────────────────────────────────────────────────
      let executeFn: (...args: unknown[]) => Promise<unknown>;
      try {
        // The LLM writes a function body. We wrap it in an async function.
        // Prepend "use strict" so accidental global leaks become errors.
        const source = `"use strict";\n${implementation}`;
        executeFn = new AsyncFunction(
          "params", "daemon", "require", "signal", "onUpdate", "ctx",
          "console", "fetch", "JSON", "Buffer", "setTimeout", "clearTimeout",
          source,
        );
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          content: [{
            type: "text" as const,
            text: `Syntax error in implementation: ${msg}\n\nFix the JavaScript syntax and try again.`,
          }],
          details: { error: "syntax_error", message: msg },
        };
      }

      // ── Smoke test ──────────────────────────────────────────────────
      // Run the function once with empty params to catch obvious errors early.
      try {
        const testResult = await executeFn(
          {},
          daemon,
          require,
          undefined,
          (_update: unknown) => {},
          { cwd: process.cwd() },
          console,
          fetch,
          JSON,
          Buffer,
          setTimeout,
          clearTimeout,
        );
        if (!testResult || typeof testResult !== "object" || !Array.isArray((testResult as any).content)) {
          return {
            content: [{
              type: "text" as const,
              text: `Implementation must return an object with a 'content' array. Got: ${JSON.stringify(testResult)}`,
            }],
            details: { error: "invalid_return" },
          };
        }
      } catch (err: unknown) {
        // Smoke test failure is ok — the params were empty, so runtime errors
        // from missing params are expected. Only reject if the error looks
        // like a code bug (e.g. ReferenceError for undefined variables).
        const msg = err instanceof Error ? err.message : String(err);
        if (msg.includes("is not defined") || msg.includes("Cannot find module")) {
          return {
            content: [{
              type: "text" as const,
              text: `Implementation failed smoke test: ${msg}\n\nCheck for undefined variables, missing imports, or broken require() calls.`,
            }],
            details: { error: "smoke_test_failed", message: msg },
          };
        }
        // Otherwise it's likely just missing params — proceed.
      }

      // ── Register ────────────────────────────────────────────────────
      const def: DynamicToolDef = {
        name,
        label,
        description,
        execute: async (params, signal, onUpdate, ctx) => {
          const result = await executeFn(
            params,
            daemon,
            require,
            signal,
            onUpdate,
            ctx,
            console,
            fetch,
            JSON,
            Buffer,
            setTimeout,
            clearTimeout,
          );
          return result as { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> | undefined };
        },
      };

      registry.set(name, def);

      // Register with pi — available immediately on the next sub-turn
      pi.registerTool({
        name,
        label,
        description,
        parameters: Type.Object({}, { additionalProperties: true }),
        async execute(_toolCallId, execParams, execSignal, execOnUpdate, execCtx) {
          const tool = registry.get(name);
          if (!tool) {
            throw new Error(`Tool '${name}' was removed. Use list_dynamic_tools to see available tools.`);
          }
          return tool.execute(
            (execParams ?? {}) as Record<string, unknown>,
            execSignal,
            execOnUpdate as ((update: unknown) => void) | undefined,
            execCtx,
          );
        },
      });

      return {
        content: [{
          type: "text" as const,
          text: `✅ Tool '${name}' registered and available immediately.\n\nLabel: ${label}\nDescription: ${description}\n\nYou can now call it as: ${name}(...)`,
        }],
        details: { name, label },
      };
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // remove_tool
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "remove_tool",
    label: "Remove Dynamic Tool",
    description:
      "Remove a previously registered dynamic tool. The tool will not be available on subsequent turns. " +
      "Use this to replace a broken tool or clean up tools you no longer need.",
    promptSnippet: "Remove a dynamically registered tool",
    promptGuidelines: [
      "Use remove_tool to retire a dynamic tool you no longer need or to replace it with a corrected version.",
      "After removing a tool, you can immediately register a replacement with the same name via register_tool.",
    ],
    parameters: Type.Object({
      name: Type.String({ description: "Name of the tool to remove (as shown by list_dynamic_tools)" }),
    }),
    async execute(_id, p) {
      const { name } = p as { name: string };
      const existed = registry.has(name);

      if (!existed) {
        return {
          content: [{
            type: "text" as const,
            text: `Tool '${name}' is not in the dynamic registry. Use list_dynamic_tools to see registered tools.`,
          }],
          details: { removed: false },
        };
      }

      // Remove from registry
      registry.delete(name);

      // Deactivate from pi's active tool set so it doesn't appear in the system prompt
      const activeNames = pi.getActiveTools()
        .map((t: unknown) => (t as { name: string }).name)
        .filter((n: string) => n !== name);
      pi.setActiveTools(activeNames);

      return {
        content: [{
          type: "text" as const,
          text: `🗑️ Tool '${name}' removed. It will no longer appear in the system prompt or be callable.`,
        }],
        details: { removed: true },
      };
    },
  });
}
