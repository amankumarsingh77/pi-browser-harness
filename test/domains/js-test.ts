import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { initTheme, Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { createFakeClient, handlerContext } from "./fake-client";
import { type ExecuteJsDetails, executeJsTool, runScriptTool } from "../../src/domains/js";
import type { BrowserClient } from "../../src/client";
import type { HandlerContext } from "../../src/util/tool";
import { ok } from "../../src/util/result";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const rendered = (component: Component): string =>
  component.render(100).map((l) => l.replace(ANSI_SEQUENCE, "").trimEnd()).join("\n");

// The renderers call getMarkdownTheme() and keyHint(), which read pi's global theme; any theme will do.
before(() => { initTheme("dark"); });
const anyTheme = (): Theme => Theme.prototype;

describe("browser_execute_js", () => {
  test("a JSON value is serialized into the text with the details describing it", async () => {
    const fake = await createFakeClient({ evaluate: () => ok({ a: 1, b: [true, null] }) });
    const r = await executeJsTool.handler({ expression: "x" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, '{"a":1,"b":[true,null]}');
    const details: ExecuteJsDetails = { valueLength: 23, preview: '{"a":1,"b":[true,null]}', isJson: true };
    assert.deepEqual(r.data.details, details);
    assert.deepEqual(fake.evaluated, ["x"]);
  });

  test("undefined is reported as the word undefined and is not JSON", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(undefined) });
    const r = await executeJsTool.handler({ expression: "void 0" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "undefined");
    assert.deepEqual(r.data.details, { valueLength: 9, preview: "undefined", isJson: false });
  });

  test("a string value is quoted, since the text is the JSON encoding", async () => {
    const fake = await createFakeClient({ evaluate: () => ok("hi") });
    const r = await executeJsTool.handler({ expression: "s" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, '"hi"');
  });

  test("the preview is capped at 120 characters plus an ellipsis", async () => {
    const fake = await createFakeClient({ evaluate: () => ok("y".repeat(300)) });
    const r = await executeJsTool.handler({ expression: "s" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.details?.preview.length, 121);
    assert.ok(r.data.details.preview.endsWith("…"));
    assert.equal(r.data.details.valueLength, 302);
    assert.equal(r.data.details.fullOutputPath, undefined);
  });

  test("targetId is forwarded as the evaluation session", async () => {
    const seen: Array<string | undefined> = [];
    const fake = await createFakeClient({
      evaluate: (_e, sessionId) => {
        seen.push(sessionId);
        return ok(1);
      },
    });
    await executeJsTool.handler({ expression: "1", targetId: "frame-7" }, handlerContext(fake.client));
    await executeJsTool.handler({ expression: "1" }, handlerContext(fake.client));
    assert.deepEqual(seen, ["frame-7", undefined]);
  });

  test("an evaluation error is a cdp_error attributed to Runtime.evaluate", async () => {
    const fake = await createFakeClient({
      evaluate: () => ({ success: false, error: { kind: "remote_error", message: "ReferenceError: x" } }),
    });
    const r = await executeJsTool.handler({ expression: "x" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "ReferenceError: x");
    assert.deepEqual(r.error.details, { method: "Runtime.evaluate" });
  });

  test("an evaluation timeout keeps its timeout kind", async () => {
    const fake = await createFakeClient({ evaluate: () => ({ success: false, error: { kind: "timeout", message: "slow" } }) });
    const r = await executeJsTool.handler({ expression: "x" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
  });
});

describe("browser_execute_js renderResult", () => {
  const result = (text: string, details: ExecuteJsDetails) => ({ content: [{ type: "text" as const, text }], details });
  const render = executeJsTool.renderResult;

  test("collapsed shows the size, the kind and the preview in a fence", () => {
    assert.ok(render);
    const out = rendered(render(result('{"a":1}', { valueLength: 7, preview: '{"a":1}', isJson: true }), false, anyTheme()));
    assert.match(out, /7 B JSON/);
    assert.match(out, /\{"a":1\}/);
    assert.match(out, /to expand/);
  });

  test("expanded pretty-prints the full JSON text, not the preview", () => {
    assert.ok(render);
    const out = rendered(render(result('{"a":[1,2]}', { valueLength: 11, preview: "ignored", isJson: true }), true, anyTheme()));
    assert.match(out, /"a": \[/);
    assert.doesNotMatch(out, /ignored/);
    assert.match(out, /to collapse/);
  });

  test("expanded names the full output file when the value was truncated", () => {
    assert.ok(render);
    const out = rendered(
      render(result("undefined", { valueLength: 9, preview: "undefined", isJson: false, fullOutputPath: "/tmp/full.txt" }), true, anyTheme()),
    );
    assert.match(out, /9 B value/);
    assert.match(out, /Full value at \/tmp\/full\.txt/);
  });
});

describe("browser_run_script", () => {
  let dir = "";
  const scriptCtx = (client: BrowserClient, onUpdate?: HandlerContext["onUpdate"], signal?: AbortSignal): HandlerContext => ({
    ...handlerContext(client, signal),
    ...(onUpdate !== undefined ? { onUpdate } : {}),
  });

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "bh-run-script-"));
  });
  test.after(async () => { await rm(dir, { recursive: true, force: true }); });

  const script = async (name: string, source: string): Promise<string> => {
    const path = join(dir, name);
    await writeFile(path, source, "utf8");
    return path;
  };

  test("a relative path is invalid_args", async () => {
    const fake = await createFakeClient();
    const r = await runScriptTool.handler({ path: "scripts/x.js" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
    assert.match(r.error.message, /absolute/);
  });

  test("a path outside tmpdir, cwd and BH_SCRIPT_DIR is invalid_args listing the allowed roots", async () => {
    const fake = await createFakeClient();
    const r = await runScriptTool.handler({ path: "/definitely-not-allowed/x.js" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
    assert.match(r.error.message, /outside allowed directories/);
    assert.ok(r.error.message.includes(tmpdir()));
  });

  test("a missing file is io_error", async () => {
    const fake = await createFakeClient();
    const r = await runScriptTool.handler({ path: join(dir, "missing.js") }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "io_error");
    assert.match(r.error.message, /Failed to read script/);
  });

  test("an empty file is invalid_args", async () => {
    const fake = await createFakeClient();
    const r = await runScriptTool.handler({ path: await script("empty.js", "") }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
    assert.equal(r.error.message, "Script is empty");
  });

  test("a syntax error is invalid_args, reported before anything runs", async () => {
    const fake = await createFakeClient();
    const r = await runScriptTool.handler({ path: await script("bad.js", "return {") }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
    assert.match(r.error.message, /^Syntax error:/);
  });

  test("the script's content items are joined into the text and its details pass through", async () => {
    const fake = await createFakeClient();
    const path = await script(
      "ok.js",
      "return { content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], details: { n: params.n * 2 } };",
    );
    const r = await runScriptTool.handler({ path, params: { n: 21 } }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "a\nb");
    assert.deepEqual(r.data.details, { n: 42 });
  });

  test("the script sees the browser client as `daemon` and gets the host bindings", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(7) });
    const path = await script(
      "daemon.js",
      `const v = await daemon.evaluateJs("1+6");
       const kinds = [typeof require, typeof signal.aborted, typeof fetch, typeof Buffer.from, typeof setTimeout];
       return { content: [{ type: 'text', text: JSON.stringify([v.data, daemon.namespace, kinds]) }] };`,
    );
    const r = await runScriptTool.handler({ path }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, '[7,"fake",["function","boolean","function","function","function"]]');
  });

  test("onUpdate forwards well-formed progress and ignores malformed updates", async () => {
    const fake = await createFakeClient();
    const seen: string[] = [];
    const path = await script(
      "progress.js",
      `onUpdate({ content: [{ type: 'text', text: 'step 1' }] });
       onUpdate('nope'); onUpdate({ content: [] }); onUpdate({ content: [{ type: 'text', text: 3 }] });
       return { content: [{ type: 'text', text: 'done' }] };`,
    );
    const r = await runScriptTool.handler({ path }, scriptCtx(fake.client, (u) => { seen.push(u.text); }));
    assert.equal(r.success, true);
    assert.deepEqual(seen, ["step 1"]);
  });

  test("a throwing onUpdate renderer does not abort the script", async () => {
    const fake = await createFakeClient();
    const path = await script("progress-throw.js", "onUpdate({ content: [{ type: 'text', text: 'x' }] }); return { content: [{ type: 'text', text: 'ok' }] };");
    const r = await runScriptTool.handler({ path }, scriptCtx(fake.client, () => { throw new Error("renderer broke"); }));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "ok");
  });

  test("a non-object return is invalid_state", async () => {
    const fake = await createFakeClient();
    const r = await runScriptTool.handler({ path: await script("num.js", "return 42;") }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.match(r.error.message, /must return an object; got 42/);
  });

  test("a return without a content array is invalid_state", async () => {
    const fake = await createFakeClient();
    const r = await runScriptTool.handler({ path: await script("nocontent.js", "return { text: 'x' };") }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.match(r.error.message, /content array/);
  });

  test("content items of the wrong shape are invalid_state", async () => {
    const fake = await createFakeClient();
    const r = await runScriptTool.handler({ path: await script("badcontent.js", "return { content: [{ type: 'image' }] };") }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.match(r.error.message, /type: 'text'/);
  });

  test("details that would not survive JSON are invalid_state", async () => {
    const fake = await createFakeClient();
    const path = await script("baddetails.js", "return { content: [{ type: 'text', text: 'x' }], details: { m: new Map() } };");
    const r = await runScriptTool.handler({ path }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.match(r.error.message, /plain JSON object/);
  });

  test("a thrown error is internal with the script's message", async () => {
    const fake = await createFakeClient();
    const r = await runScriptTool.handler({ path: await script("throw.js", "throw new Error('kaboom');") }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "internal");
    assert.equal(r.error.message, "Script execution failed: kaboom");
  });

  test("the timeout aborts a script that never returns", async () => {
    const fake = await createFakeClient();
    const path = await script("hang.js", "await new Promise(() => {}); return { content: [] };");
    const r = await runScriptTool.handler({ path, timeoutMs: 100 }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "internal");
    assert.match(r.error.message, /script aborted/);
  });

  test("the caller's abort signal cancels the script", async () => {
    const fake = await createFakeClient();
    const ac = new AbortController();
    const path = await script("hang2.js", "await new Promise(() => {}); return { content: [] };");
    const pending = runScriptTool.handler({ path, timeoutMs: 60_000 }, scriptCtx(fake.client, undefined, ac.signal));
    ac.abort();
    const r = await pending;
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "internal");
    assert.match(r.error.message, /script aborted/);
  });
});
