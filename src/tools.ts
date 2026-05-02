/**
 * Tool registrations for pi-browser-harness.
 *
 * Maps browser-harness daemon methods to pi tools with TypeBox schemas,
 * prompt snippets, guidelines, and TUI renderers.
 */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserDaemon } from "./daemon";
import type { TabInfo } from "./protocol";

// ── AsyncFunction constructor ────────────────────────────────────────────────

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

// ── Key code map ─────────────────────────────────────────────────────────────

const SPECIAL_KEYS = [
  "Enter", "Tab", "Backspace", "Escape", "Delete",
  "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown",
  "Home", "End", "PageUp", "PageDown", " ",
];

// ── Screenshot path ──────────────────────────────────────────────────────────

let screenshotCounter = 0;
function nextScreenshotPath(): string {
  screenshotCounter++;
  return join(tmpdir(), `pi-browser-screenshot-${Date.now()}-${screenshotCounter}.png`);
}

// ── Output truncation ────────────────────────────────────────────────────────

/** Track temp directories for cleanup on session shutdown. */
const tempDirs: string[] = [];

/** Best-effort cleanup of all tracked temp directories. */
export async function cleanupTempDirs(): Promise<void> {
  const dirs = tempDirs.splice(0);
  await Promise.all(
    dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})),
  );
}

/**
 * Truncate output to pi's built-in limits (50KB / 2000 lines).
 * When truncated, writes the full output to a temp file so the LLM
 * can read it via the read tool and so CTRL+O expand can show it.
 */
async function applyTruncation(
  output: string,
  prefix: string,
): Promise<{
  text: string;
  fullOutputPath?: string;
  wasTruncated: boolean;
}> {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) {
    return { text: truncation.content, wasTruncated: false };
  }

  const tempDir = await mkdtemp(join(tmpdir(), `pi-bh-${prefix}-`));
  tempDirs.push(tempDir);

  const tempFile = join(tempDir, "output.txt");
  await withFileMutationQueue(tempFile, async () => {
    await writeFile(tempFile, output, "utf8");
  });

  const omittedBytes = truncation.totalBytes - truncation.outputBytes;
  let text = truncation.content;
  text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
  text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  text += ` ${formatSize(omittedBytes)} omitted. Full output: ${tempFile}]`;

  return { text, fullOutputPath: tempFile, wasTruncated: true };
}

// ── Registration ─────────────────────────────────────────────────────────────

export function registerTools(pi: ExtensionAPI, daemon: BrowserDaemon): void {
// ═══════════════════════════════════════════════════════════════════════════
  // browser_execute_js
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_execute_js",
    label: "Browser Execute JS",
    description:
      'Execute JavaScript in the current page and return the result. Use for data extraction, DOM inspection, and page manipulation. Expressions with "return" are automatically wrapped in an IIFE.',
    promptSnippet: "Execute JavaScript in the page and return the result",
    promptGuidelines: [
      "Use browser_execute_js for extracting structured data from the page (text, attributes, JSON from embedded scripts).",
      "Use browser_execute_js for DOM inspection when coordinates from screenshots aren't sufficient.",
      "For bulk data extraction, prefer browser_http_get for API calls — it's 10-50x faster than browser DOM scraping.",
      "To execute JS inside an iframe, first find the iframe target via browser_list_tabs (includeChrome: true to see iframe targets), then pass targetId to browser_execute_js.",
      "Compositor clicks (browser_click) already pass through iframes — only use iframe JS when you need to read/change iframe DOM.",
    ],
    parameters: Type.Object({
      expression: Type.String({ description: "JavaScript expression to evaluate. 'return' statements are auto-wrapped in IIFE." }),
      targetId: Type.Optional(Type.String({ description: "Target ID of an iframe to evaluate in (optional)" })),
    }),
    async execute(_id, params) {
      try {
        await daemon.ensureAlive();
        const value = await daemon.evaluateJS(params.expression, params.targetId);
        const raw = value === undefined ? "undefined" : JSON.stringify(value, null, 2);
        const { text, fullOutputPath } = await applyTruncation(raw, "js");
        return {
          content: [{ type: "text" as const, text }],
          details: { valueLength: raw.length, fullOutputPath },
        };
      } catch (err) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `JS execution failed: ${err instanceof Error ? err.message : String(err)}` }],
          details: undefined,
        };
      }
    },
    renderResult(result, { expanded }, theme) {
      const details = result.details as {
        valueLength?: number;
        fullOutputPath?: string;
      } | undefined;

      const len = details?.valueLength ?? 0;

      if (expanded) {
        // Expanded (CTRL+O): show the full JS result
        const content = result.content[0];
        const raw = content?.type === "text" ? content.text : "";
        return new Text(raw || "undefined", 0, 0);
      }

      // Collapsed (default): size + first-line preview
      const content = result.content[0];
      const raw = content?.type === "text" ? content.text : "";
      const firstLine = raw.split("\n")[0] || "";
      const preview =
        firstLine.length > 120 ? firstLine.slice(0, 117) + "..." : firstLine;

      const summary = `📜 JS result (${formatSize(len)})`;
      return new Text(
        theme
          ? theme.fg("dim", summary) + "\n" + theme.fg("muted", preview)
          : summary + "\n" + preview,
        0,
        0,
      );
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // browser_run_script
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerTool({
    name: "browser_run_script",
    label: "Browser Run Script",
    description:
      "Execute a temporary JavaScript script file with access to the browser daemon " +
      "and Node.js APIs. Use this when the built-in browser_* tools are insufficient " +
      "for a multi-step workflow — write a script to disk, then run it with this tool. " +
      "The script receives these bindings in scope:\n" +
      "  params    — the arguments passed to this tool\n" +
      "  daemon    — the browser daemon (daemon.cdp(), daemon.evaluateJS(), daemon.getPageInfo(), etc.)\n" +
      "  require   — Node.js require() for builtins and installed packages\n" +
      "  signal    — AbortSignal for cancellation\n" +
      "  onUpdate  — progress callback: onUpdate({ content: [{ type: 'text', text: '...' }] })\n" +
      "  ctx       — ExtensionContext with cwd, sessionManager, ui, signal, etc.\n" +
      "  console, fetch, JSON, Buffer, setTimeout, clearTimeout\n\n" +
      "The script MUST return { content: [{ type: 'text', text: '...' }], details?: {...} }.\n" +
      "For errors, throw: throw new Error('something went wrong').",
    promptSnippet: "Run a temporary script with browser daemon access (write script to disk first)",
    promptGuidelines: [
      "Use write to create a temporary script file, then browser_run_script to execute it — no dynamic tool registration needed.",
      "Scripts are written to disk, making them auditable and re-runnable. The user can inspect them.",
      "The script has access to the browser daemon via `daemon` — use daemon.cdp(), daemon.evaluateJS(), daemon.getPageInfo(), etc.",
      "For pure data processing or file operations, use require() to access Node.js modules like fs, path, crypto.",
      "If the script only needs built-in browser_* tools, break those into separate tool calls before or after — do not try to invoke them from within the script.",
    ],
    parameters: Type.Object({
      path: Type.String({ description: "Path to the temporary script file (.js or .mjs) to execute" }),
      params: Type.Optional(Type.Object({}, { additionalProperties: true, description: "Optional parameters to pass to the script as `params`" })),
    }),
    async execute(_id, p, signal, onUpdate, ctx) {
      const { path: scriptPath, params: scriptParams } = p as {
        path: string;
        params?: Record<string, unknown>;
      };

      // ── Read the script from disk ────────────────────────────────────
      let source: string;
      try {
        source = await readFile(scriptPath, "utf8");
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `Failed to read script: ${msg}\n\nPath: ${scriptPath}\nCheck that the file exists and is readable.`,
          }],
          details: { error: "read_failed", message: msg },
        };
      }

      if (source.trim().length === 0) {
        return {
          isError: true,
          content: [{ type: "text" as const, text: `Script is empty: ${scriptPath}` }],
          details: { error: "empty_script" },
        };
      }

      // ── Compile ─────────────────────────────────────────────────────
      let executeFn: (...args: unknown[]) => Promise<unknown>;
      try {
        const wrapped = `"use strict";\n${source}`;
        executeFn = new AsyncFunction(
          "params", "daemon", "require", "signal", "onUpdate", "ctx",
          "console", "fetch", "JSON", "Buffer", "setTimeout", "clearTimeout",
          wrapped,
        );
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `Syntax error in script: ${msg}\n\nFile: ${scriptPath}\nFix the JavaScript syntax and try again.`,
          }],
          details: { error: "syntax_error", message: msg },
        };
      }

      // ── Execute ─────────────────────────────────────────────────────
      try {
        const result = await executeFn(
          scriptParams ?? {},
          daemon,
          require,
          signal,
          onUpdate ?? ((_update: unknown) => {}),
          ctx ?? { cwd: process.cwd() },
          console,
          fetch,
          JSON,
          Buffer,
          setTimeout,
          clearTimeout,
        );

        if (!result || typeof result !== "object" || !Array.isArray((result as any).content)) {
          return {
            isError: true,
            content: [{
              type: "text" as const,
              text: `Script must return { content: [{ type: 'text', text: '...' }], details?: {...} }.\nGot: ${JSON.stringify(result)}\n\nFile: ${scriptPath}`,
            }],
            details: { error: "invalid_return" },
          };
        }

        return result as { content: Array<{ type: "text"; text: string }>; details: Record<string, unknown> | undefined };
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        return {
          isError: true,
          content: [{
            type: "text" as const,
            text: `Script execution failed: ${msg}\n\nFile: ${scriptPath}\nCheck for runtime errors, undefined variables, or broken require() calls.`,
          }],
          details: { error: "execution_failed", message: msg },
        };
      }
    },
  });
}
