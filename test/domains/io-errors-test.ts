import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { join } from "node:path";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { createFakeClient, handlerContext } from "./fake-client";
import { printToPdfTool } from "../../src/domains/files";
import { readFileResult, statResult, writeFileResult } from "../../src/domains/io";
import { ok } from "../../src/util/result";

const PDF = ok({ data: Buffer.from("%PDF-1.4 fake").toString("base64") });

describe("browser_print_to_pdf", () => {
  test("an unwritable output path is an io_error, not a thrown exception", async () => {
    const fake = await createFakeClient({ canned: { "Page.printToPDF": PDF } });
    const outputPath = join(tmpdir(), `does-not-exist-${process.pid}`, "nested", "out.pdf");
    const r = await printToPdfTool.handler({ outputPath }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "io_error");
    assert.match(r.error.message, /Cannot write file/);
    assert.deepEqual(r.error.details, { path: outputPath });
  });

  test("a writable path receives the decoded PDF bytes", async () => {
    const dir = await mkdtemp(join(tmpdir(), "bh-pdf-"));
    try {
      const fake = await createFakeClient({ canned: { "Page.printToPDF": PDF } });
      const outputPath = join(dir, "out.pdf");
      const r = await printToPdfTool.handler({ outputPath }, handlerContext(fake.client));
      assert.equal(r.success, true);
      assert.equal((await readFile(outputPath)).toString(), "%PDF-1.4 fake");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

describe("io helpers", () => {
  test("writeFileResult reports a missing directory as io_error with the path", async () => {
    const path = join(tmpdir(), `does-not-exist-${process.pid}`, "x.bin");
    const r = await writeFileResult(path, "x");
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "io_error");
    assert.deepEqual(r.error.details, { path });
  });

  test("readFileResult and statResult report a missing file as io_error", async () => {
    const path = join(tmpdir(), `does-not-exist-${process.pid}.txt`);
    const read = await readFileResult(path);
    const st = await statResult(path);
    assert.equal(read.success, false);
    assert.equal(st.success, false);
    assert.equal(read.error.kind, "io_error");
    assert.equal(st.error.kind, "io_error");
  });
});
