import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, readFile, rm, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createFakeClient, handlerContext } from "./fake-client";
import { printToPdfTool, uploadFileTool } from "../../src/domains/files";
import type { CdpError } from "../../src/cdp/errors";
import { type Result, ok } from "../../src/util/result";

const DOCUMENT = ok({ root: { nodeId: 1 } });
const MATCHED = ok({ nodeId: 5 });
const NO_MATCH = ok({ nodeId: 0 });

// Scripts the two evaluations the selector path can make: the post-CDP verification and the JS DataTransfer fallback.
const evaluations = (verify: Result<unknown, CdpError>, fallback: Result<unknown, CdpError>) =>
  (expression: string): Result<unknown, CdpError> => (expression.includes("new DataTransfer()") ? fallback : verify);

describe("browser_upload_file", () => {
  let dir = "";
  let filePath = "";

  before(async () => {
    dir = await mkdtemp(join(tmpdir(), "bh-upload-"));
    filePath = join(dir, "note.txt");
    await writeFile(filePath, "file body", "utf8");
  });
  after(async () => { await rm(dir, { recursive: true, force: true }); });

  test("an unreadable file is io_error before any CDP call", async () => {
    const fake = await createFakeClient({ refs: [{ ref: "e1", backendId: 101 }] });
    const missing = join(dir, "missing.txt");
    const r = await uploadFileTool.handler({ ref: "e1", filePath: missing }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "io_error");
    assert.match(r.error.message, /Cannot read file/);
    assert.ok(r.error.message.includes(missing));
    assert.equal(fake.calls.length, 0);
  });

  test("by ref: sets the files on the backend node and reports the cdp mode", async () => {
    const fake = await createFakeClient({ refs: [{ ref: "e1", backendId: 101 }] });
    const r = await uploadFileTool.handler({ ref: "e1", selector: "#ignored", filePath }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, `Uploaded ${filePath} via CDP (ref e1)`);
    assert.deepEqual(r.data.details, { mode: "cdp", ref: "e1", filePath });
    assert.deepEqual(fake.calls.map((c) => c.method), ["DOM.setFileInputFiles"]);
    assert.deepEqual(fake.calls[0]?.params, { files: [filePath], backendNodeId: 101 });
    assert.equal(fake.evaluated.length, 0, "the ref path never falls back to the selector");
  });

  test("by ref: a stale ref is invalid_state carrying the ref", async () => {
    const fake = await createFakeClient();
    const r = await uploadFileTool.handler({ ref: "e2", filePath }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.deepEqual(r.error.details, { ref: "e2" });
    assert.equal(fake.calls.length, 0);
  });

  test("by ref: a failed set is a cdp_error naming the method", async () => {
    const fake = await createFakeClient({
      refs: [{ ref: "e1", backendId: 101 }],
      canned: { "DOM.setFileInputFiles": { success: false, error: { kind: "remote_error", message: "not a file input" } } },
    });
    const r = await uploadFileTool.handler({ ref: "e1", filePath }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "not a file input");
    assert.deepEqual(r.error.details, { method: "DOM.setFileInputFiles" });
  });

  test("neither ref nor selector is invalid_args", async () => {
    const fake = await createFakeClient();
    const r = await uploadFileTool.handler({ filePath }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
    assert.equal(fake.calls.length, 0);
  });

  test("by selector: looks the input up through DOM, sets the files and verifies the count", async () => {
    const fake = await createFakeClient({
      canned: { "DOM.getDocument": DOCUMENT, "DOM.querySelector": MATCHED },
      evaluate: evaluations(ok(1), ok(0)),
    });
    const r = await uploadFileTool.handler({ selector: "input[type=file]", filePath }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, `Uploaded ${filePath} via CDP`);
    assert.deepEqual(r.data.details, { mode: "cdp", filePath });
    assert.deepEqual(fake.calls.map((c) => c.method), ["DOM.getDocument", "DOM.querySelector", "DOM.setFileInputFiles"]);
    assert.deepEqual(fake.calls[0]?.params, { depth: -1 });
    assert.deepEqual(fake.calls[1]?.params, { nodeId: 1, selector: "input[type=file]" });
    assert.deepEqual(fake.calls[2]?.params, { files: [filePath], nodeId: 5 });
    assert.equal(fake.evaluated.length, 1);
    assert.match(fake.evaluated[0] ?? "", /querySelector\("input\[type=file\]"\)\?\.files\?\.length/);
  });

  test("by selector: no DOM match falls back to a JS DataTransfer carrying the file bytes", async () => {
    const fake = await createFakeClient({
      canned: { "DOM.getDocument": DOCUMENT, "DOM.querySelector": NO_MATCH },
      evaluate: evaluations(ok(0), ok(1)),
    });
    const r = await uploadFileTool.handler({ selector: "#up", filePath }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, `Uploaded ${filePath} via JS DataTransfer`);
    assert.deepEqual(r.data.details, { mode: "js", filePath });
    assert.equal(fake.callsTo("DOM.setFileInputFiles").length, 0);
    const expr = fake.evaluated[0] ?? "";
    assert.ok(expr.includes(`atob("${Buffer.from("file body").toString("base64")}")`));
    assert.ok(expr.includes('new File([bytes], "note.txt", { type: "text/plain"'));
    assert.match(expr, /querySelector\("#up"\)/);
  });

  test("by selector: a verification count of 0 falls back to JS, and the mime type follows the extension", async () => {
    const png = join(dir, "pic.png");
    await writeFile(png, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
    const fake = await createFakeClient({
      canned: { "DOM.getDocument": DOCUMENT, "DOM.querySelector": MATCHED },
      evaluate: evaluations(ok(0), ok(1)),
    });
    const r = await uploadFileTool.handler({ selector: "#up", filePath: png }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(r.data.details, { mode: "js", filePath: png });
    assert.equal(fake.callsTo("DOM.setFileInputFiles").length, 1);
    assert.ok((fake.evaluated[1] ?? "").includes('{ type: "image/png"'));
  });

  test("by selector: both paths failing is one cdp_error carrying both reasons", async () => {
    const fake = await createFakeClient({
      canned: { "DOM.getDocument": DOCUMENT, "DOM.querySelector": NO_MATCH },
      evaluate: evaluations(ok(0), { success: false, error: { kind: "remote_error", message: "File input not found" } }),
    });
    const r = await uploadFileTool.handler({ selector: "#nope", filePath }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "Both CDP and JS fallback failed. CDP: Selector matched 0 file inputs: #nope; JS: File input not found");
  });

  test("by selector: a JS fallback that sets no files is also a failure", async () => {
    const fake = await createFakeClient({
      canned: { "DOM.getDocument": { success: false, error: { kind: "timeout", message: "DOM slow" } } },
      evaluate: evaluations(ok(0), ok(0)),
    });
    const r = await uploadFileTool.handler({ selector: "#up", filePath }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "Both CDP and JS fallback failed. CDP: DOM slow; JS: JS fallback set 0 files");
  });
});

describe("browser_print_to_pdf", () => {
  const PDF = ok({ data: Buffer.from("%PDF-1.7 bytes").toString("base64") });

  test("without outputPath the PDF lands in tmpdir under the client's namespace", async () => {
    const fake = await createFakeClient({ canned: { "Page.printToPDF": PDF } });
    const r = await printToPdfTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    const path = r.data.details?.["path"];
    assert.equal(typeof path, "string");
    if (typeof path !== "string") return;
    try {
      assert.ok(path.startsWith(join(tmpdir(), "pi-browser-pdf-fake-")), path);
      assert.ok(path.endsWith(".pdf"));
      assert.equal(r.data.text, `PDF saved: ${path}`);
      assert.equal((await readFile(path)).toString(), "%PDF-1.7 bytes");
    } finally {
      await unlink(path);
    }
  });

  test("prints with backgrounds and CSS page size", async () => {
    const fake = await createFakeClient({ canned: { "Page.printToPDF": PDF } });
    const dir = await mkdtemp(join(tmpdir(), "bh-pdf-params-"));
    try {
      await printToPdfTool.handler({ outputPath: join(dir, "x.pdf") }, handlerContext(fake.client));
      assert.deepEqual(fake.callsTo("Page.printToPDF")[0]?.params, { printBackground: true, preferCSSPageSize: true });
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  test("a failed print is a cdp_error naming the method and writes nothing", async () => {
    const fake = await createFakeClient({
      canned: { "Page.printToPDF": { success: false, error: { kind: "remote_error", message: "printing not supported" } } },
    });
    const dir = await mkdtemp(join(tmpdir(), "bh-pdf-fail-"));
    try {
      const outputPath = join(dir, "x.pdf");
      const r = await printToPdfTool.handler({ outputPath }, handlerContext(fake.client));
      assert.equal(r.success, false);
      assert.equal(r.error.kind, "cdp_error");
      assert.equal(r.error.message, "printing not supported");
      assert.deepEqual(r.error.details, { method: "Page.printToPDF" });
      await assert.rejects(readFile(outputPath));
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
