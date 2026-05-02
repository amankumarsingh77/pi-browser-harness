import { readFile } from "node:fs/promises";
import { resolve, isAbsolute } from "node:path";
import { tmpdir } from "node:os";
import { createRequire } from "node:module";
import { Type } from "typebox";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { applyTruncation } from "../util/truncate";

// AsyncFunction constructor — the documented Node.js mechanism for compiling
// arbitrary user-supplied source. Equivalent to `new Function` but produces an
// async function we can `await`. The full RCE risk is contained at the source
// boundary: see the path allowlist + timeout below. A plain `unknown` cast
// would lose the constructor signature; we keep this single typed cast.
const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as
  new (...args: ReadonlyArray<string>) => (...args: ReadonlyArray<unknown>) => Promise<unknown>;

// ESNext module — bare `require` is not in scope. createRequire provides the
// CJS resolver anchored to this file's URL so scripts can require() builtins
// and installed CJS packages.
const requireFromHere = createRequire(import.meta.url);

const ExecuteJsArgs = Type.Object({
  expression: Type.String({ description: "JavaScript expression. `return X` is auto-wrapped in an IIFE." }),
  targetId: Type.Optional(Type.String({ description: "Optional iframe targetId; default = current page." })),
});

export const executeJsTool = defineBrowserTool({
  name: "browser_execute_js",
  label: "Browser Execute JS",
  description:
    "Run JavaScript in the page (or a specific iframe target). `return X` gets auto-wrapped in an IIFE for convenience. Always use safeJs / JSON.stringify when interpolating untrusted strings into source.",
  promptSnippet: "Execute JS in the page (or iframe)",
  promptGuidelines: [
    "`return foo` is auto-wrapped in an IIFE — both `foo` and `(() => foo)()` work.",
    "For iframes, get a targetId via browser_execute_js with `Object.values(document.querySelectorAll('iframe'))` then call browser_execute_js with targetId.",
    "Result must be JSON-serializable (Runtime.evaluate returnByValue=true).",
  ],
  parameters: ExecuteJsArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await client.evaluateJs(args.expression, args.targetId);
    if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
    const valueStr = r.data === undefined ? "undefined" : JSON.stringify(r.data);
    const truncated = await applyTruncation(valueStr, "js");
    return ok({
      text: truncated.text,
      details: truncated.fullOutputPath !== undefined
        ? { valueLength: valueStr.length, fullOutputPath: truncated.fullOutputPath }
        : { valueLength: valueStr.length },
    });
  },
});

const RunScriptArgs = Type.Object({
  path: Type.String({ description: "Absolute path to the script file (.js or .mjs)" }),
  params: Type.Optional(
    Type.Object({}, { additionalProperties: true, description: "Args passed to the script as `params`" }),
  ),
  timeoutMs: Type.Optional(
    Type.Integer({
      default: 60_000,
      minimum: 100,
      maximum: 600_000,
      description: "Hard timeout in ms. Default 60s, max 600s.",
    }),
  ),
});

const allowedRoots = (): ReadonlyArray<string> => {
  const env = process.env["BH_SCRIPT_DIR"];
  return [tmpdir(), process.cwd(), ...(env !== undefined ? [env] : [])].map((d) => resolve(d));
};

const isPathAllowed = (p: string): boolean => {
  const abs = resolve(p);
  return allowedRoots().some((root) => abs === root || abs.startsWith(`${root}/`));
};

const MAX_SOURCE_BYTES = 1_000_000;

type ContentItem = { readonly type: "text"; readonly text: string };

const isContentItem = (v: unknown): v is ContentItem =>
  typeof v === "object" && v !== null
    && (v as Readonly<Record<string, unknown>>)["type"] === "text"
    && typeof (v as Readonly<Record<string, unknown>>)["text"] === "string";

export const runScriptTool = defineBrowserTool({
  name: "browser_run_script",
  label: "Browser Run Script",
  description:
    "Execute a temporary JavaScript script with full Node.js + browser-daemon access. Path must be inside tmpdir, cwd, or BH_SCRIPT_DIR. Mandatory timeout. The script is full RCE on the harness's process — only invoke scripts you wrote and reviewed.",
  promptSnippet: "Run a temporary script with daemon + Node access (security-bounded)",
  promptGuidelines: [
    "Write the script with the write tool first; pass its absolute path.",
    "Path must be inside tmpdir, cwd, or BH_SCRIPT_DIR — otherwise rejected.",
    "Default timeout is 60s; pass timeoutMs to extend (max 600s).",
    "Script bindings: params, daemon, require, signal, onUpdate, ctx, console, fetch, JSON, Buffer, setTimeout, clearTimeout.",
    "Script MUST return { content: [{ type: 'text', text: '...' }], details?: {...} }. Throw on errors.",
  ],
  parameters: RunScriptArgs,
  async handler(args, { client, signal, onUpdate, extensionCtx }): Promise<Result<ToolOk, ToolErr>> {
    if (!isAbsolute(args.path)) {
      return err({ kind: "invalid_state", message: "Script path must be absolute" });
    }
    if (!isPathAllowed(args.path)) {
      return err({
        kind: "invalid_state",
        message: `Script path outside allowed directories (allowed: ${allowedRoots().join(", ")})`,
      });
    }
    let source: string;
    try {
      source = await readFile(args.path, "utf8");
    } catch (e) {
      return err({
        kind: "io_error",
        message: `Failed to read script: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    if (source.length === 0) return err({ kind: "invalid_state", message: "Script is empty" });
    if (source.length > MAX_SOURCE_BYTES) {
      return err({ kind: "invalid_state", message: `Script exceeds ${MAX_SOURCE_BYTES}B size cap` });
    }

    let executeFn: (...a: ReadonlyArray<unknown>) => Promise<unknown>;
    try {
      executeFn = new AsyncFunction(
        "params", "daemon", "require", "signal", "onUpdate", "ctx",
        "console", "fetch", "JSON", "Buffer", "setTimeout", "clearTimeout",
        `"use strict";\n${source}`,
      );
    } catch (e) {
      return err({
        kind: "invalid_state",
        message: `Syntax error: ${e instanceof Error ? e.message : String(e)}`,
      });
    }

    const timeoutMs = args.timeoutMs ?? 60_000;
    const ac = new AbortController();
    const onAbort = (): void => ac.abort();
    if (signal !== undefined) signal.addEventListener("abort", onAbort, { once: true });
    const timeoutTimer = setTimeout(() => ac.abort(), timeoutMs);

    try {
      const scriptPromise = executeFn(
        args.params ?? {},
        client,                     // bound as `daemon` — name preserved for back-compat
        requireFromHere,
        ac.signal,
        (u: unknown) => {
          if (typeof u !== "object" || u === null) return;
          const content = (u as Readonly<Record<string, unknown>>)["content"];
          if (!Array.isArray(content) || content.length === 0) return;
          const first = content[0];
          if (typeof first !== "object" || first === null) return;
          const txt = (first as Readonly<Record<string, unknown>>)["text"];
          if (typeof txt !== "string") return;
          try { onUpdate({ text: txt }); } catch { /* swallow */ }
        },
        extensionCtx ?? { cwd: process.cwd() },
        console, fetch, JSON, Buffer, setTimeout, clearTimeout,
      );
      const abortPromise = new Promise<never>((_, reject) => {
        ac.signal.addEventListener("abort", () => reject(new Error("script aborted (timeout or cancellation)")), { once: true });
      });
      const result = await Promise.race([scriptPromise, abortPromise]);
      clearTimeout(timeoutTimer);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);

      if (typeof result !== "object" || result === null) {
        return err({ kind: "invalid_state", message: `Script must return an object; got ${JSON.stringify(result)}` });
      }
      const content = (result as Readonly<Record<string, unknown>>)["content"];
      if (!Array.isArray(content)) {
        return err({ kind: "invalid_state", message: "Script return value must have a content array" });
      }
      if (!content.every(isContentItem)) {
        return err({ kind: "invalid_state", message: "Script content array must contain { type: 'text', text: string } items" });
      }
      const textOut = content.map((c) => c.text).join("\n");
      const details = (result as Readonly<Record<string, unknown>>)["details"];
      const isPlainObject = typeof details === "object" && details !== null && !Array.isArray(details);
      return isPlainObject
        ? ok({ text: textOut, details: details as Readonly<Record<string, unknown>> })
        : ok({ text: textOut });
    } catch (e) {
      clearTimeout(timeoutTimer);
      if (signal !== undefined) signal.removeEventListener("abort", onAbort);
      return err({
        kind: "internal",
        message: `Script execution failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
  },
});
