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
import { toCanvasPoint, DEFAULT_MAX_SECONDS } from "../../src/domains/record-session";
import { buildCursorScript } from "../../src/domains/record-encoder";
import { cdpCall } from "../../src/domains/cdp-call";
import { createFakeClient, type FakeClient } from "./fake-client";
import { ok, err } from "../../src/util/result";
import { cdpError } from "../../src/cdp/errors";

const execFileP = promisify(execFile);
const ENV_KEY = "PI_BROWSER_RECORDINGS_DIR";
const originalRecordingsDir = process.env[ENV_KEY];

const flush = async (ticks = 3): Promise<void> => {
  for (let i = 0; i < ticks; i++) await tick();
};

// The cap fires a fire-and-forget finalize() that closes a real ffmpeg process — how long that
// takes depends on machine load, not wall-clock elapsed since the cap's deadline. Poll for the
// sink to actually finish rather than guessing a wait long enough to outlast it.
const waitForCapToFinalize = async (fake: FakeClient, timeoutMs = 5000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (fake.session.activeRecording()?.lastSummary() != null) return;
    await wait(20);
  }
  throw new Error("timed out waiting for the capped recording to finalize");
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

const emitFrames = (fake: FakeClient, count: number, sessionId = "s1"): void => {
  for (let i = 0; i < count; i++) {
    fake.emit({
      method: "Page.screencastFrame",
      sessionId,
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

  test("S26: a failed screencast subscribe releases the sink it already spawned", async () => {
    freshDir();
    const fake = await createFakeClient({
      canned: {
        "Page.startScreencast": [err(cdpError("invalid_response", "screencast rejected by target")), ok({})],
        "Browser.getWindowBounds": ok({ bounds: ORIGINAL_BOUNDS }),
        "Browser.setWindowBounds": ok({}),
      },
    });
    const r = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(r.success, false);
    if (r.success) return;
    assert.equal(r.error.kind, "cdp_error");
    assert.match(r.error.message, /screencast rejected by target/);

    // No sink is left reachable — a later start is not blocked by the one that failed.
    assert.equal(fake.session.activeRecording(), null);

    // The window was parked before the failure and must have been put back, not left off-screen.
    const boundsCalls = fake.callsTo("Browser.setWindowBounds");
    assert.equal(boundsCalls.length, 2, "park then restore");
    const restoreBounds = boundsCalls[1]?.params["bounds"] as Record<string, unknown>;
    assert.equal(restoreBounds["left"], ORIGINAL_BOUNDS.left);
    assert.equal(restoreBounds["top"], ORIGINAL_BOUNDS.top);

    // The ffmpeg process that createRecordingSink spawned was closed rather than orphaned — a
    // second start (a fresh sink, fresh ffmpeg) must be free to proceed immediately.
    const second = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(second.success, true);
    if (second.success) await recordStopTool.handler({}, ctxFor(fake));
  });

  test("S13: switching tabs continues the same recording, driven end-to-end through the tools", async () => {
    freshDir();
    const fake = await createFakeClient({
      canned: {
        "Target.getTargets": ok({
          targetInfos: [
            { targetId: "t1", type: "page", title: "One", url: "https://one.test/" },
            { targetId: "t2", type: "page", title: "Two", url: "https://two.test/" },
          ],
        }),
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s2" })],
        "Target.activateTarget": ok({}),
        "Page.startScreencast": ok({}),
        "Page.stopScreencast": ok({}),
      },
      ownedTargetIds: ["t1", "t2"],
    });

    const started = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(started.success, true);

    emitFrames(fake, 2, "s1");
    await flush();

    const switched = await fake.session.switchTo("t2");
    assert.equal(switched.success, true);
    assert.equal(fake.session.activeRecording() !== null, true, "the recording was never finalized at the moment of the switch");

    const stopCalls = fake.callsTo("Page.stopScreencast");
    assert.equal(stopCalls.length, 1);
    assert.equal(stopCalls[0]?.sessionId, "s1", "screencast stopped on the outgoing tab's session");
    const startCalls = fake.callsTo("Page.startScreencast");
    assert.equal(startCalls.length, 2);
    assert.equal(startCalls[1]?.sessionId, "s2", "screencast started on the incoming tab's session");

    emitFrames(fake, 2, "s2");
    await flush();

    const stopped = await recordStopTool.handler({}, ctxFor(fake));
    assert.equal(stopped.success, true);
    if (!stopped.success) return;
    const details = stopped.data.details as Record<string, unknown>;
    assert.equal(details["sourceLost"], null, "the resubscribe succeeded, so nothing was lost");
    assert.ok((details["bytes"] as number) > 0, "exactly one file was produced, covering both tabs");
  });

  test("S22: closing the recorded tab does not corrupt the recording", async () => {
    freshDir();
    const fake = await createFakeClient({
      canned: { "Page.startScreencast": ok({}), "Page.stopScreencast": ok({}) },
    });

    const started = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(started.success, true);

    emitFrames(fake, 2);
    await flush();

    assert.doesNotThrow(() => {
      fake.emit({ method: "Target.targetDestroyed", params: { targetId: "t1" } });
    });
    await flush();
    assert.notEqual(fake.session.activeRecording(), null, "the harness does not throw and the session stays usable");

    const stopped = await recordStopTool.handler({}, ctxFor(fake));
    assert.equal(stopped.success, true, "the stop call succeeds and returns a playable file covering the time before the close");
    if (!stopped.success) return;
    const details = stopped.data.details as Record<string, unknown>;
    assert.ok((details["bytes"] as number) > 0);
    assert.match(details["sourceLost"] as string, /closed/, "the summary reports that the recording lost its source");
    assert.match(stopped.data.text, /lost its source/i);
  });
});

describe("cursor track", () => {
  test("S14: viewport coordinates are transformed into canvas space, not stored raw", () => {
    // A 900x600 tab letterboxed into 1280x720: scale is min(1280/900, 720/600) = 1.2, so the
    // scaled content is 1080x720 and sits 100px in from the left with no vertical padding.
    assert.deepEqual(toCanvasPoint(0, 0, 900, 600), { x: 100, y: 0 });
    assert.deepEqual(toCanvasPoint(450, 300, 900, 600), { x: 640, y: 360 });
    assert.deepEqual(toCanvasPoint(900, 600, 900, 600), { x: 1180, y: 720 });

    // A source that already matches the canvas aspect needs no offset at all.
    assert.deepEqual(toCanvasPoint(640, 360, 1280, 720), { x: 640, y: 360 });

    // Unknown source dimensions must not silently produce NaN or a raw passthrough.
    assert.deepEqual(toCanvasPoint(10, 10, 0, 0), { x: 0, y: 0 });
  });

  test("S14: agent mouse input reaches the recording's track with the right kind, and is a no-op when idle", async () => {
    freshDir();
    const fake = await createFakeClient({
      canned: { "Input.dispatchMouseEvent": ok({}), "Page.startScreencast": ok({}), "Page.stopScreencast": ok({}) },
    });

    // With no recording active the same input must record nothing and still succeed.
    const idle = await cdpCall(fake.client, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: 10, y: 20, button: "left", clickCount: 1,
    });
    assert.equal(idle.success, true, "the call still succeeds with no recording active");

    const started = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(started.success, true);
    emitFrames(fake, 2);
    await flush();

    await cdpCall(fake.client, "Input.dispatchMouseEvent", {
      type: "mousePressed", x: 100, y: 100, button: "left", clickCount: 1,
    });
    await cdpCall(fake.client, "Input.dispatchMouseEvent", {
      type: "mouseMoved", x: 200, y: 150, button: "none", clickCount: 0,
    });
    await flush();

    const stopped = await recordStopTool.handler({}, ctxFor(fake));
    assert.equal(stopped.success, true);
    if (!stopped.success) return;
    const details = stopped.data.details as Record<string, unknown>;
    assert.equal(details["cursorPoints"], 2, "both actions appear in the track — the idle one did not");
    assert.equal(details["cursorClicks"], 1, "the click is marked as a click and the move is not");
  });

  test("S14: the cursor script places moves and click flashes in time order", () => {
    const script = buildCursorScript([
      { t: 0, x: 100, y: 100, kind: "move" },
      { t: 1.5, x: 400, y: 300, kind: "click" },
      { t: 2, x: 700, y: 150, kind: "move" },
    ]);
    const lines = script.trim().split("\n");

    // Commands sharing a timestamp are comma-separated without repeating it — repeating the
    // timestamp is a parse error that kills the whole graph (docs/ARCHITECTURE.md).
    for (const line of lines) {
      assert.match(line, /^\d+\.\d{3} [a-z@]/, `each entry starts with exactly one timestamp: ${line}`);
      assert.doesNotMatch(line.slice(6), /\d+\.\d{3} overlay/, `no repeated timestamp: ${line}`);
    }

    const times = lines.map((l) => Number.parseFloat(l));
    assert.deepEqual([...times].sort((a, b) => a - b), times, "entries are in ascending time order");

    assert.match(script, /0\.000 overlay@cur x 100, overlay@cur y 100;/);
    // A click's line carries the flash commands too, so it continues past the cursor coordinates.
    assert.match(script, /1\.500 overlay@cur x 400, overlay@cur y 300,/);

    // The click raises the flash and a later command lowers it again, so it is short-lived.
    const raise = lines.findIndex((l) => l.includes("flash") && /aa 0\.[1-9]/.test(l));
    const lower = lines.findIndex((l) => l.includes("flash") && /aa 0(\.0+)?[,;]/.test(l));
    assert.ok(raise >= 0, "a click raises the flash");
    assert.ok(lower > raise, "and a later command lowers it again");
    assert.ok(times[lower]! - times[raise]! <= 0.5, "the flash is short-lived");
  });

  test("S14: a track with no clicks produces no flash commands at all", () => {
    const script = buildCursorScript([{ t: 0, x: 5, y: 5, kind: "move" }]);
    assert.doesNotMatch(script, /flash/, "no click means no flash chain is driven");
  });
});

describe("duration cap", () => {
  test("S17: a recording that reaches its cap ends itself and admits it, freeing the slot for a new one", async () => {
    freshDir();
    const fake = await createFakeClient({
      canned: {
        "Page.startScreencast": ok({}),
        "Page.stopScreencast": ok({}),
        "Browser.getWindowBounds": ok({ bounds: ORIGINAL_BOUNDS }),
        "Browser.setWindowBounds": ok({}),
      },
    });
    const started = await recordStartTool.handler({ maxSeconds: 1 }, ctxFor(fake));
    assert.equal(started.success, true);

    emitFrames(fake, 2);
    await flush();

    await waitForCapToFinalize(fake);

    assert.notEqual(
      fake.session.activeRecording()?.lastSummary(),
      null,
      "the sink finalized itself on its own, without a browser_record_stop call",
    );
    assert.equal(fake.callsTo("Browser.setWindowBounds").length, 2, "the window was restored, exactly as on a normal stop");

    const restarted = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(restarted.success, true, "a subsequent browser_record_start is accepted, not refused as a duplicate");
    if (restarted.success) await recordStopTool.handler({}, ctxFor(fake));
  });

  test("S17: a browser_record_stop after the cap returns the capped recording's path rather than an error", async () => {
    freshDir();
    const fake = await createFakeClient({
      canned: { "Page.startScreencast": ok({}), "Page.stopScreencast": ok({}) },
    });
    const started = await recordStartTool.handler({ maxSeconds: 1 }, ctxFor(fake));
    assert.equal(started.success, true);
    if (!started.success) return;
    const cappedPath = (started.data.details as Record<string, unknown>)["path"] as string;

    emitFrames(fake, 2);
    await flush();
    await waitForCapToFinalize(fake);

    const stopped = await recordStopTool.handler({}, ctxFor(fake));
    assert.equal(stopped.success, true);
    if (!stopped.success) return;
    const details = stopped.data.details as Record<string, unknown>;
    assert.equal(details["path"], cappedPath);
    assert.equal(details["truncated"], true, "the summary reports the recording as truncated");
    assert.ok((details["bytes"] as number) > 0, "the file is playable");
    assert.match(stopped.data.text, /cap/i);
  });

  test("S18: the cap defaults to five minutes and can be overridden, and rejects a non-positive override", async () => {
    freshDir();
    const fake = await createFakeClient({ canned: { "Page.startScreencast": ok({}) } });
    const withDefault = await recordStartTool.handler({}, ctxFor(fake));
    assert.equal(withDefault.success, true);
    if (withDefault.success) assert.match(withDefault.data.text, new RegExp(`Capped at ${String(DEFAULT_MAX_SECONDS)}s`));
    await recordStopTool.handler({}, ctxFor(fake));

    const fake2 = await createFakeClient({ canned: { "Page.startScreencast": ok({}) } });
    const withOverride = await recordStartTool.handler({ maxSeconds: 30 }, ctxFor(fake2));
    assert.equal(withOverride.success, true);
    if (withOverride.success) assert.match(withOverride.data.text, /Capped at 30s/);
    await recordStopTool.handler({}, ctxFor(fake2));

    const fake3 = await createFakeClient();
    for (const bad of [0, -30, Number.POSITIVE_INFINITY, Number.NaN]) {
      const refused = await recordStartTool.handler({ maxSeconds: bad }, ctxFor(fake3));
      assert.equal(refused.success, false, `maxSeconds ${String(bad)} must be refused`);
      if (refused.success) continue;
      assert.equal(refused.error.kind, "invalid_state");
      assert.equal(fake3.session.activeRecording(), null, "not silently defaulted to a running recording");
    }
  });
});
