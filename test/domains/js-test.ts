import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createFakeClient, handlerContext } from "./fake-client";
import { installTheme, renderedText, testTheme } from "./client-overrides";
import { type ExecuteJsDetails, executeJsTool, runScriptTool } from "../../src/domains/js";
import type { BrowserClient } from "../../src/client";
import type { HandlerContext } from "../../src/util/tool";
import { ok } from "../../src/util/result";


// The renderers call getMarkdownTheme() and keyHint(), which read pi's global theme.
before(() => {
  installTheme();
});

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

  test("a timeout says the script may have partly run and how to wait longer", async () => {
    const fake = await createFakeClient({
      evaluate: () => ({ success: false, error: { kind: "remote_error", message: "Timeout after 30000ms: Runtime.evaluate" } }),
    });
    const r = await executeJsTool.handler({ expression: "x" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.match(r.error.message, /may have partly run/);
    assert.match(r.error.message, /timeoutMs/);
    assert.equal(r.error.details?.["timeoutMs"], 30_000);
  });
});

describe("browser_execute_js renderResult", () => {
  const result = (text: string, details: ExecuteJsDetails) => ({ content: [{ type: "text" as const, text }], details });
  const render = executeJsTool.renderResult;

  test("collapsed shows the size, the kind and the preview in a fence", () => {
    assert.ok(render);
    const out = renderedText(render(result('{"a":1}', { valueLength: 7, preview: '{"a":1}', isJson: true }), false, testTheme), 100);
    assert.match(out, /7 B JSON/);
    assert.match(out, /\{"a":1\}/);
    assert.match(out, /to expand/);
  });

  test("expanded pretty-prints the full JSON text, not the preview", () => {
    assert.ok(render);
    const out = renderedText(render(result('{"a":[1,2]}', { valueLength: 11, preview: "ignored", isJson: true }), true, testTheme), 100);
    assert.match(out, /"a": \[/);
    assert.doesNotMatch(out, /ignored/);
    assert.match(out, /to collapse/);
  });

  test("expanded names the full output file when the value was truncated", () => {
    assert.ok(render);
    const out = renderedText(
      render(result("undefined", { valueLength: 9, preview: "undefined", isJson: false, fullOutputPath: "/tmp/full.txt" }), true, testTheme),
      100,
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

  // A loop like the scraper that ran away: navigate, wait, extract, with the extraction errors swallowed.
  const navigateLoop = [
    "for (;;) {",
    "  await daemon.session().call('Page.navigate', { url: 'https://example.test/' });",
    "  await new Promise((r) => setTimeout(r, 10));",
    "  try { await daemon.evaluateJs('1'); } catch {}",
    "}",
  ].join("\n");
  const settle = (ms: number): Promise<void> => new Promise((r) => { setTimeout(r, ms); });

  test("after a timeout the script can no longer drive the browser", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(1) });
    const path = await script("runaway.js", navigateLoop);
    const r = await runScriptTool.handler({ path, timeoutMs: 100 }, handlerContext(fake.client));
    assert.equal(r.success, false);
    const navsAtAbort = fake.callsTo("Page.navigate").length;
    const evalsAtAbort = fake.evaluated.length;
    assert.ok(navsAtAbort > 0, "the loop ran before the timeout");
    await settle(150);
    assert.equal(fake.callsTo("Page.navigate").length, navsAtAbort, "no navigation after the abort");
    assert.equal(fake.evaluated.length, evalsAtAbort, "no evaluation after the abort");
  });

  test("after the caller aborts the script can no longer drive the browser", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(1) });
    const ac = new AbortController();
    const path = await script("runaway2.js", navigateLoop);
    const pending = runScriptTool.handler({ path, timeoutMs: 60_000 }, scriptCtx(fake.client, undefined, ac.signal));
    await settle(60);
    ac.abort();
    await pending;
    const navsAtAbort = fake.callsTo("Page.navigate").length;
    await settle(150);
    assert.equal(fake.callsTo("Page.navigate").length, navsAtAbort);
  });

  test("a browser call still in flight at the abort rejects instead of handing its result to the script", async () => {
    let release: () => void = () => undefined;
    const gate = new Promise<void>((r) => { release = r; });
    const fake = await createFakeClient();
    const slow: BrowserClient = { ...fake.client, evaluateJs: async () => { await gate; return ok("late"); } };
    const path = await script("inflight.js", [
      "let got = 'nothing';",
      "try { got = await daemon.evaluateJs('x'); } catch (e) { got = 'threw: ' + e.message; }",
      "params.out.got = got;",
      "return { content: [{ type: 'text', text: 'done' }] };",
    ].join("\n"));
    const out: Record<string, unknown> = {};
    const r = await runScriptTool.handler({ path, timeoutMs: 100, params: { out } }, handlerContext(slow));
    assert.equal(r.success, false);
    release();
    await settle(20);
    assert.match(String(out["got"]), /^threw: .*script aborted/);
  });

  test("a second script on the same browser client is refused while the first is running", async () => {
    const fake = await createFakeClient();
    const ac = new AbortController();
    const first = runScriptTool.handler(
      { path: await script("hold.js", "await new Promise(() => {}); return { content: [] };"), timeoutMs: 60_000 },
      scriptCtx(fake.client, undefined, ac.signal),
    );
    const second = await runScriptTool.handler(
      { path: await script("quick.js", "return { content: [{ type: 'text', text: 'ran' }] };") },
      handlerContext(fake.client),
    );
    assert.equal(second.success, false);
    assert.equal(second.error.kind, "invalid_state");
    assert.match(second.error.message, /already running in this browser session/);
    ac.abort();
    await first;
  });

  test("once the first script ends, a new one on the same client runs", async () => {
    const fake = await createFakeClient();
    const ac = new AbortController();
    const first = runScriptTool.handler(
      { path: await script("hold2.js", "await new Promise(() => {}); return { content: [] };"), timeoutMs: 60_000 },
      scriptCtx(fake.client, undefined, ac.signal),
    );
    ac.abort();
    await first;
    const next = await runScriptTool.handler(
      { path: await script("quick2.js", "return { content: [{ type: 'text', text: 'ran' }] };") },
      handlerContext(fake.client),
    );
    assert.equal(next.success, true);
    assert.equal(next.data.text, "ran");
  });

  test("a script that switches tabs still holds the slot, so a second run on that tab is refused", async () => {
    const fake = await createFakeClient({
      canned: {
        "Target.getTargets": ok({ targetInfos: [
          { targetId: "t1", type: "page", title: "One", url: "https://one.test/" },
          { targetId: "t2", type: "page", title: "Two", url: "https://two.test/" },
        ] }),
      },
      ownedTargetIds: ["t1", "t2"],
    });
    const ac = new AbortController();
    const first = runScriptTool.handler(
      { path: await script("switcher.js", "await daemon.session().switchTo('t2'); await new Promise(() => {}); return { content: [] };"), timeoutMs: 60_000 },
      scriptCtx(fake.client, undefined, ac.signal),
    );
    await settle(30);
    assert.equal(fake.client.current()?.targetId, "t2", "the script moved the client to t2");
    const second = await runScriptTool.handler(
      { path: await script("quick4.js", "return { content: [{ type: 'text', text: 'ran' }] };") },
      handlerContext(fake.client),
    );
    assert.equal(second.success, false);
    assert.equal(second.error.kind, "invalid_state");
    ac.abort();
    await first;
  });

  test("scripts on different browser clients run side by side", async () => {
    const a = await createFakeClient();
    const b = await createFakeClient();
    const ac = new AbortController();
    const first = runScriptTool.handler(
      { path: await script("hold3.js", "await new Promise(() => {}); return { content: [] };"), timeoutMs: 60_000 },
      scriptCtx(a.client, undefined, ac.signal),
    );
    const other = await runScriptTool.handler(
      { path: await script("quick3.js", "return { content: [{ type: 'text', text: 'ran' }] };") },
      handlerContext(b.client),
    );
    assert.equal(other.success, true);
    ac.abort();
    await first;
  });

  test("a script aborted while holding the mutation mutex can still release it", async () => {
    const fake = await createFakeClient();
    const path = await script("mutex.js", [
      "const release = await daemon.mutationMutex().acquire();",
      "try { await new Promise((r) => setTimeout(r, 200)); } finally { release(); }",
      "return { content: [] };",
    ].join("\n"));
    const r = await runScriptTool.handler({ path, timeoutMs: 100 }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.match(r.error.message, /script aborted/);
    await settle(200);
    const release = await Promise.race([
      fake.client.mutationMutex().acquire(),
      settle(500).then(() => null),
    ]);
    assert.notEqual(release, null, "the mutex was released by the aborted script");
    if (release !== null) release();
  });

  test("a release handle that arrives after the abort is still usable", async () => {
    const fake = await createFakeClient();
    const holder = await fake.client.mutationMutex().acquire();
    const path = await script("mutex2.js", [
      "const release = await daemon.mutationMutex().acquire();",
      "release();",
      "return { content: [] };",
    ].join("\n"));
    const r = await runScriptTool.handler({ path, timeoutMs: 100 }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.match(r.error.message, /script aborted/);
    holder();
    await settle(30);
    const again = await Promise.race([fake.client.mutationMutex().acquire(), settle(500).then(() => null)]);
    assert.notEqual(again, null, "the late-granted lock was released, not stranded");
    if (again !== null) again();
  });
});
