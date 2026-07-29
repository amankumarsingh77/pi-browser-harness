import { test, describe, before, afterEach } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, mkdtempSync, readdirSync, rmSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setImmediate as tick, setTimeout as wait } from "node:timers/promises";
import type { HandlerContext } from "../../src/util/tool";
import { recordStartTool, recordStopTool } from "../../src/domains/record";
import { createFakeClient, type FakeClient } from "./fake-client";
import { ok, err } from "../../src/util/result";
import { cdpError } from "../../src/cdp/errors";

const execFileP = promisify(execFile);
const ENV_KEY = "PI_BROWSER_RECORDINGS_DIR";
const originalRecordingsDir = process.env[ENV_KEY];

const flush = async (ticks = 3): Promise<void> => {
  for (let i = 0; i < ticks; i++) await tick();
};

const ORIGINAL_BOUNDS = { left: 100, top: 50, width: 800, height: 600, windowState: "normal" };

const ctxFor = (fake: FakeClient): HandlerContext => ({
  client: fake.client,
  signal: undefined,
  onUpdate: () => {},
  extensionCtx: undefined as never,
});

// A real 1-frame JPEG from the system ffmpeg (already a verified execution precondition of this
// plan) — the pipeline downstream genuinely needs a decodable frame, not a stand-in buffer.
let jpegBase64: string;

before(async () => {
  const { stdout } = await execFileP(
    "ffmpeg",
    ["-f", "lavfi", "-i", "color=c=red:s=32x32", "-frames:v", "1", "-f", "image2", "pipe:1"],
    { encoding: "buffer", maxBuffer: 10 * 1024 * 1024 },
  );
  jpegBase64 = Buffer.from(stdout).toString("base64");
});

const emitFrames = (fake: FakeClient, count: number): void => {
  for (let i = 0; i < count; i++) {
    fake.emit({
      method: "Page.screencastFrame",
      sessionId: "s1",
      params: { data: jpegBase64, sessionId: i, metadata: {} },
    });
  }
};

let tmpDirs: string[] = [];

const freshDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pi-record-test-"));
  tmpDirs.push(dir);
  process.env[ENV_KEY] = dir;
  return dir;
};

afterEach(() => {
  if (originalRecordingsDir === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = originalRecordingsDir;
  for (const dir of tmpDirs.splice(0)) {
    try {
      chmodSync(dir, 0o755);
    } catch {
      // best-effort — the dir may already be gone or unaffected
    }
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch {
      // best-effort cleanup
    }
  }
});

describe("browser_record_start / browser_record_stop", () => {
  test("S1: starting a recording returns the file it will write", async () => {
    const dir = freshDir();
    const fake = await createFakeClient({ canned: { "Page.startScreencast": ok({}) } });
    const r = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(r.success, true);
    if (!r.success) return;
    const path = r.data.details?.["path"];
    assert.equal(typeof path, "string");
    assert.match(path as string, /\.mp4$/);
    assert.ok((path as string).startsWith(dir));
    assert.equal(fake.callsTo("Page.startScreencast").length, 1);
    await recordStopTool.handler({}, ctxFor(fake));
  });

  test("S2: stopping a recording reports the finished file", async () => {
    freshDir();
    const fake = await createFakeClient({
      canned: { "Page.startScreencast": ok({}), "Page.stopScreencast": ok({}) },
    });
    const started = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(started.success, true);

    emitFrames(fake, 5);
    await flush();

    const stopped = await recordStopTool.handler({}, ctxFor(fake));
    assert.equal(stopped.success, true);
    if (!stopped.success) return;
    const details = stopped.data.details as Record<string, unknown>;
    assert.equal(typeof details["path"], "string");
    assert.ok((details["durationSec"] as number) > 0);
    assert.ok((details["bytes"] as number) > 0);
  });

  test("S3: a second start while recording is refused, and names the file in progress", async () => {
    freshDir();
    const fake = await createFakeClient({ canned: { "Page.startScreencast": ok({}) } });
    const first = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(first.success, true);
    if (!first.success) return;
    const firstPath = (first.data.details as Record<string, unknown>)["path"] as string;

    const second = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(second.success, false);
    if (second.success) return;
    assert.equal(second.error.kind, "invalid_state");
    assert.ok(second.error.message.includes(firstPath));
    assert.equal(fake.session.activeRecording()?.outputPath, firstPath);

    await recordStopTool.handler({}, ctxFor(fake));
  });

  test("S4: stopping when nothing is recording is refused", async () => {
    freshDir();
    const fake = await createFakeClient();
    const r = await recordStopTool.handler({}, ctxFor(fake));
    assert.equal(r.success, false);
    if (r.success) return;
    assert.equal(r.error.kind, "invalid_state");
  });

  test("S5: a missing ffmpeg is reported as an actionable error, not a broken file", async () => {
    freshDir();
    const originalPath = process.env["PATH"];
    process.env["PATH"] = "";
    try {
      const fake = await createFakeClient();
      const r = await recordStartTool.handler({}, ctxFor(fake));
      assert.equal(r.success, false);
      if (r.success) return;
      assert.equal(r.error.kind, "io_error");
      assert.match(r.error.message, /ffmpeg/i);
      assert.match(r.error.message, /install/i);
      assert.equal(fake.session.activeRecording(), null);
    } finally {
      if (originalPath === undefined) delete process.env["PATH"];
      else process.env["PATH"] = originalPath;
    }
  });

  test("S20: frames are not accumulated — no frame directory is ever written", async () => {
    const dir = freshDir();
    const fake = await createFakeClient({
      canned: { "Page.startScreencast": ok({}), "Page.stopScreencast": ok({}) },
    });
    await recordStartTool.handler({}, ctxFor(fake));

    emitFrames(fake, 20);
    await flush(5);

    const stopped = await recordStopTool.handler({}, ctxFor(fake));
    assert.equal(stopped.success, true);

    const entries = readdirSync(dir);
    assert.deepEqual(
      entries.filter((f) => !f.endsWith(".mp4")),
      [],
      "no non-mp4 entry (e.g. a frame directory) should exist in the recordings directory",
    );
    assert.equal(entries.filter((f) => f.endsWith(".mp4")).length, 1);
  });

  test("S23: an encoder that dies mid-recording surfaces at stop, not a zero-byte success", async () => {
    const dir = freshDir();
    // Read+execute only: ffmpeg can look up the directory but cannot open its output file for writing inside it.
    chmodSync(dir, 0o555);
    const fake = await createFakeClient({
      canned: { "Page.startScreencast": ok({}), "Page.stopScreencast": ok({}) },
    });
    const started = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(started.success, true);

    await flush();
    const stopped = await recordStopTool.handler({}, ctxFor(fake));
    assert.equal(stopped.success, false);
    if (stopped.success) return;
    assert.equal(stopped.error.kind, "io_error");
    assert.match(stopped.error.message, /ffmpeg|encoder/i);
  });

  test("S24: a missing recordings directory is created, not fatal", async () => {
    const base = mkdtempSync(join(tmpdir(), "pi-record-test-"));
    tmpDirs.push(base);
    const nested = join(base, "nested", "recordings");
    process.env[ENV_KEY] = nested;

    const fake = await createFakeClient({ canned: { "Page.startScreencast": ok({}) } });
    const r = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(r.success, true);
    assert.equal(existsSync(nested), true);
    await recordStopTool.handler({}, ctxFor(fake));
  });

  test("S24: a recordings directory that cannot be created fails with io_error naming the path", async () => {
    const base = mkdtempSync(join(tmpdir(), "pi-record-test-"));
    tmpDirs.push(base);
    chmodSync(base, 0o555);
    const blocked = join(base, "blocked-subdir");
    process.env[ENV_KEY] = blocked;

    const fake = await createFakeClient();
    const r = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(r.success, false);
    if (r.success) return;
    assert.equal(r.error.kind, "io_error");
    assert.ok(r.error.message.includes(blocked));
  });

  test("S9: starting a recording moves the window out of the way without hiding it", async () => {
    freshDir();
    const fake = await createFakeClient({
      canned: {
        "Page.startScreencast": ok({}),
        "Browser.getWindowBounds": ok({ bounds: ORIGINAL_BOUNDS }),
        "Browser.setWindowBounds": ok({}),
      },
    });
    const started = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(started.success, true);
    if (!started.success) return;
    assert.equal(started.data.details?.["parked"], true);
    assert.match(started.data.text, /parked off-screen/);

    const parkCalls = fake.callsTo("Browser.setWindowBounds");
    assert.equal(parkCalls.length, 1);
    const bounds = parkCalls[0]?.params["bounds"] as Record<string, unknown>;
    assert.equal(bounds["windowState"], "normal");
    assert.notEqual(bounds["left"], ORIGINAL_BOUNDS.left);
    assert.notEqual(bounds["top"], ORIGINAL_BOUNDS.top);
    assert.equal(bounds["width"], ORIGINAL_BOUNDS.width);
    assert.equal(bounds["height"], ORIGINAL_BOUNDS.height);

    await recordStopTool.handler({}, ctxFor(fake));
  });

  test("S10: stopping a recording puts the window back", async () => {
    freshDir();
    const fake = await createFakeClient({
      canned: {
        "Page.startScreencast": ok({}),
        "Page.stopScreencast": ok({}),
        "Browser.getWindowBounds": ok({ bounds: ORIGINAL_BOUNDS }),
        "Browser.setWindowBounds": ok({}),
      },
    });
    await recordStartTool.handler({}, ctxFor(fake));
    emitFrames(fake, 1);
    await flush();
    const stopped = await recordStopTool.handler({}, ctxFor(fake));
    assert.equal(stopped.success, true);

    const boundsCalls = fake.callsTo("Browser.setWindowBounds");
    assert.equal(boundsCalls.length, 2, "one call to park, one to restore");
    const restoreBounds = boundsCalls[1]?.params["bounds"] as Record<string, unknown>;
    assert.equal(restoreBounds["left"], ORIGINAL_BOUNDS.left);
    assert.equal(restoreBounds["top"], ORIGINAL_BOUNDS.top);
    assert.equal(restoreBounds["width"], ORIGINAL_BOUNDS.width);
    assert.equal(restoreBounds["height"], ORIGINAL_BOUNDS.height);
    assert.equal(restoreBounds["windowState"], "normal");
  });

  test("S10: restoration also happens when the recording ends because of an encoder error", async () => {
    const dir = freshDir();
    chmodSync(dir, 0o555);
    const fake = await createFakeClient({
      canned: {
        "Page.startScreencast": ok({}),
        "Browser.getWindowBounds": ok({ bounds: ORIGINAL_BOUNDS }),
        "Browser.setWindowBounds": ok({}),
      },
    });
    const started = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(started.success, true);
    await flush();
    const stopped = await recordStopTool.handler({}, ctxFor(fake));
    assert.equal(stopped.success, false);

    const boundsCalls = fake.callsTo("Browser.setWindowBounds");
    assert.equal(boundsCalls.length, 2, "restore still runs even though the encoder failed");
  });

  test("S11: a stretch with no frames does not end the recording", async () => {
    freshDir();
    const fake = await createFakeClient({
      canned: { "Page.startScreencast": ok({}), "Page.stopScreencast": ok({}) },
    });
    const started = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(started.success, true);

    emitFrames(fake, 1);
    await flush();
    assert.notEqual(fake.session.activeRecording(), null, "still active during the silent stretch");

    await wait(300);
    assert.notEqual(fake.session.activeRecording(), null, "still active during the silent stretch");

    emitFrames(fake, 1);
    await flush();
    assert.notEqual(fake.session.activeRecording(), null, "still active once frames resume");

    const stopped = await recordStopTool.handler({}, ctxFor(fake));
    assert.equal(stopped.success, true);
    if (!stopped.success) return;
    const details = stopped.data.details as Record<string, unknown>;
    assert.ok((details["durationSec"] as number) > 0);
  });

  test("S12: a frozen stretch is reported rather than hidden", async () => {
    freshDir();
    const fake = await createFakeClient({
      canned: { "Page.startScreencast": ok({}), "Page.stopScreencast": ok({}) },
    });
    await recordStartTool.handler({}, ctxFor(fake));

    emitFrames(fake, 1);
    await flush();
    await wait(1200);

    const stopped = await recordStopTool.handler({}, ctxFor(fake));
    assert.equal(stopped.success, true);
    if (!stopped.success) return;
    const details = stopped.data.details as Record<string, unknown>;
    assert.ok((details["frozenSec"] as number) > 1, `expected frozenSec > 1, got ${String(details["frozenSec"])}`);
    assert.match(stopped.data.text, /frozen/i);
  });

  test("S12: a recording with no frozen stretch reports zero and says nothing about freezing", async () => {
    freshDir();
    const fake = await createFakeClient({
      canned: { "Page.startScreencast": ok({}), "Page.stopScreencast": ok({}) },
    });
    await recordStartTool.handler({}, ctxFor(fake));
    emitFrames(fake, 1);
    await flush();
    const stopped = await recordStopTool.handler({}, ctxFor(fake));
    assert.equal(stopped.success, true);
    if (!stopped.success) return;
    const details = stopped.data.details as Record<string, unknown>;
    assert.equal(details["frozenSec"], 0);
    assert.doesNotMatch(stopped.data.text, /frozen/i);
  });

  test("S25: a window that cannot be moved does not kill the recording", async () => {
    freshDir();
    const fake = await createFakeClient({
      canned: {
        "Page.startScreencast": ok({}),
        "Page.stopScreencast": ok({}),
        "Browser.getWindowBounds": err(cdpError("invalid_response", "getWindowBounds not supported")),
      },
    });
    const started = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(started.success, true);
    if (!started.success) return;
    assert.equal(started.data.details?.["parked"], false);
    assert.match(started.data.text, /could not be moved/);

    emitFrames(fake, 1);
    await flush();
    const stopped = await recordStopTool.handler({}, ctxFor(fake));
    assert.equal(stopped.success, true);
    if (!stopped.success) return;
    assert.ok((stopped.data.details?.["bytes"] as number) > 0);

    assert.equal(fake.callsTo("Browser.setWindowBounds").length, 0, "no restore attempted");
  });
});
