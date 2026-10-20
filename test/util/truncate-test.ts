import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, mkdirSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import { applyTruncation, cleanupTempDirs, formatBytes } from "../../src/util/truncate";

const TEMP_VARS = ["TMPDIR", "TEMP", "TMP"] as const;

describe("applyTruncation", () => {
  // os.tmpdir() reads the environment on every call, so pointing it at a sandbox keeps the spill
  // files (and the cleanup under test) away from the real temp directory.
  let sandbox: string;
  const saved = new Map<string, string | undefined>();

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), "pi-truncate-test-"));
    for (const v of TEMP_VARS) {
      saved.set(v, process.env[v]);
      process.env[v] = sandbox;
    }
    assert.equal(tmpdir(), sandbox, "os.tmpdir() did not follow the environment override");
  });

  after(async () => {
    await cleanupTempDirs();
    for (const v of TEMP_VARS) {
      const prev = saved.get(v);
      if (prev === undefined) Reflect.deleteProperty(process.env, v);
      else process.env[v] = prev;
    }
    rmSync(sandbox, { recursive: true, force: true });
  });

  const spillDirs = (): ReadonlyArray<string> => readdirSync(sandbox).filter((d) => d.startsWith("pi-bh-"));

  test("short output passes through untouched with no spill file", async () => {
    const r = await applyTruncation("hello\nworld", "short");
    assert.equal(r.wasTruncated, false);
    assert.equal(r.text, "hello\nworld");
    assert.equal(r.fullOutputPath, undefined);
    assert.equal(spillDirs().length, 0);
  });

  test("output at exactly the line limit is not truncated", async () => {
    const output = Array.from({ length: DEFAULT_MAX_LINES }, (_, i) => `l${i}`).join("\n");
    const r = await applyTruncation(output, "edge");
    assert.equal(r.wasTruncated, false);
    assert.equal(r.text, output);
  });

  test("output over the line limit is cut to the limit and spilled in full to a temp file", async () => {
    const lines = Array.from({ length: DEFAULT_MAX_LINES + 5 }, (_, i) => `line-${i}`);
    const output = lines.join("\n");
    const r = await applyTruncation(output, "lines");
    assert.equal(r.wasTruncated, true);
    assert.ok(r.fullOutputPath, "a spill path is reported");
    assert.ok(r.text.startsWith(lines.slice(0, DEFAULT_MAX_LINES).join("\n")), "head of the output is kept");
    assert.ok(!r.text.includes(`line-${DEFAULT_MAX_LINES + 4}\n`), "the tail is not in the inline text");
    assert.match(r.text, new RegExp(`\\[Output truncated: ${DEFAULT_MAX_LINES} of ${DEFAULT_MAX_LINES + 5} lines`));
    assert.ok(r.text.endsWith(`Full output: ${r.fullOutputPath}]`));
    assert.equal(readFileSync(r.fullOutputPath, "utf8"), output, "the spill file holds the untruncated output");
  });

  test("output over the byte limit is truncated even with few lines", async () => {
    const output = "x".repeat(DEFAULT_MAX_BYTES + 1024);
    const r = await applyTruncation(output, "bytes");
    assert.equal(r.wasTruncated, true);
    assert.ok(r.text.length < output.length);
    assert.ok(r.fullOutputPath);
    assert.equal(readFileSync(r.fullOutputPath, "utf8").length, output.length);
  });

  test("the spill directory is named after the prefix and lives in the temp directory", async () => {
    const r = await applyTruncation("y\n".repeat(DEFAULT_MAX_LINES + 1), "my-tool");
    assert.ok(r.fullOutputPath);
    const dir = dirname(r.fullOutputPath);
    assert.equal(dirname(dir), sandbox);
    assert.ok(dir.startsWith(join(sandbox, "pi-bh-my-tool-")), dir);
    assert.ok(r.fullOutputPath.endsWith("output.txt"));
  });

  test("each truncation gets its own directory", async () => {
    const a = await applyTruncation("a\n".repeat(DEFAULT_MAX_LINES + 1), "same");
    const b = await applyTruncation("b\n".repeat(DEFAULT_MAX_LINES + 1), "same");
    assert.ok(a.fullOutputPath && b.fullOutputPath);
    assert.notEqual(dirname(a.fullOutputPath), dirname(b.fullOutputPath));
  });

  test("cleanupTempDirs removes every spill directory it created and nothing else", async () => {
    const r = await applyTruncation("z\n".repeat(DEFAULT_MAX_LINES + 1), "clean");
    assert.ok(r.fullOutputPath);
    const foreign = join(sandbox, "pi-bh-foreign-not-ours");
    mkdirSync(foreign);
    assert.ok(spillDirs().length >= 2);

    await cleanupTempDirs();

    assert.equal(existsSync(dirname(r.fullOutputPath)), false, "our spill dir is gone");
    assert.ok(existsSync(foreign), "a directory the module did not create survives");
    assert.deepEqual(spillDirs(), ["pi-bh-foreign-not-ours"]);
    rmSync(foreign, { recursive: true, force: true });
  });

  test("cleanupTempDirs is idempotent and tolerates directories already removed", async () => {
    const r = await applyTruncation("w\n".repeat(DEFAULT_MAX_LINES + 1), "gone");
    assert.ok(r.fullOutputPath);
    rmSync(dirname(r.fullOutputPath), { recursive: true, force: true });
    await cleanupTempDirs();
    await cleanupTempDirs();
    assert.equal(spillDirs().length, 0);
  });
});

describe("formatBytes", () => {
  test("bytes below 1 KiB are printed as B", () => {
    assert.equal(formatBytes(0), "0 B");
    assert.equal(formatBytes(1023), "1023 B");
  });

  test("KB and MB use one decimal and binary thresholds", () => {
    assert.equal(formatBytes(1024), "1.0 KB");
    assert.equal(formatBytes(1536), "1.5 KB");
    assert.equal(formatBytes(1_048_575), "1024.0 KB");
    assert.equal(formatBytes(1_048_576), "1.0 MB");
    assert.equal(formatBytes(5 * 1_048_576 + 524_288), "5.5 MB");
  });
});
