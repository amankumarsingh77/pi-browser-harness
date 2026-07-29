import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { existsSync, statSync } from "node:fs";
import { rm } from "node:fs/promises";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonTransport } from "../../src/daemon/transport";
import { createBrowserClient } from "../../src/client";
import { recordStartTool, recordStopTool } from "../../src/domains/record";
import { ensureDaemon } from "../../src/daemon/spawn";
import type { HandlerContext } from "../../src/util/tool";

const execFileP = promisify(execFile);

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string): void => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
};

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// A page whose viewport is deliberately not 16:9: a solid, saturated background so a decoded
// frame's corner pixels prove letterboxing (black) and its center pixel proves the page content
// reached the canvas unmodified (S8).
const FIXTURE = `<!doctype html><meta charset=utf-8>
<body style="margin:0;background:#ff0040;overflow:hidden">
<div id=t style="color:#fff;font:20px system-ui;padding:1rem"></div>
<script>
let n = 0;
function frame() {
  n++;
  document.getElementById('t').textContent = 'frame ' + n + ' t=' + (performance.now() / 1000).toFixed(2) + 's';
  requestAnimationFrame(frame);
}
requestAnimationFrame(frame);
</script>`;

async function ffprobeJson(path: string): Promise<any> {
  const { stdout } = await execFileP("ffprobe", [
    "-v", "error", "-print_format", "json", "-show_streams", "-show_format", path,
  ]);
  return JSON.parse(stdout);
}

// Reads a single decoded frame as raw RGB24 pixels so corner/centre colours can be checked directly, without a PNG decoder dependency.
async function readFramePixels(path: string, width: number, height: number, atSec: number): Promise<Buffer> {
  const { stdout } = await execFileP(
    "ffmpeg",
    ["-v", "error", "-ss", String(atSec), "-i", path, "-frames:v", "1", "-f", "rawvideo", "-pix_fmt", "rgb24", "pipe:1"],
    { encoding: "buffer", maxBuffer: 50 * 1024 * 1024 },
  );
  const buf = Buffer.from(stdout);
  if (buf.length !== width * height * 3) throw new Error(`unexpected raw frame size: ${buf.length}`);
  return buf;
}

const pixelAt = (buf: Buffer, width: number, x: number, y: number): [number, number, number] => {
  const i = (y * width + x) * 3;
  return [buf[i] ?? 0, buf[i + 1] ?? 0, buf[i + 2] ?? 0];
};

// ffprobe reports avg_frame_rate as a "num/den" fraction (e.g. "15/1"), never as a bare expression to evaluate.
const parseFrameRate = (raw: string | undefined): number => {
  if (!raw) return 0;
  const [numRaw, denRaw] = raw.split("/");
  const num = Number(numRaw);
  const den = denRaw !== undefined ? Number(denRaw) : 1;
  if (!Number.isFinite(num) || !Number.isFinite(den) || den === 0) return 0;
  return num / den;
};

async function main(): Promise<void> {
  const recordingsDir = mkdtempSync(join(tmpdir(), "pi-record-e2e-"));
  process.env["PI_BROWSER_RECORDINGS_DIR"] = recordingsDir;

  const daemonUp = await ensureDaemon();
  check(daemonUp, "daemon is running");
  if (!daemonUp) { console.error("Could not bring up the daemon — aborting."); process.exit(1); }

  const transport = createDaemonTransport("pi-record-e2e-test");
  const client = createBrowserClient({ namespace: "pi-record-e2e-test", transport });
  const ctx: HandlerContext = {
    client,
    signal: undefined,
    onUpdate: () => {},
    extensionCtx: undefined as never,
  };

  const started = await client.start();
  check(started.success, `client started: ${started.success ? "ok" : started.error.message}`);
  if (!started.success) process.exit(1);

  const url = "data:text/html," + encodeURIComponent(FIXTURE);
  const tab = await client.newTab(url);
  check(tab.success, `opened fixture tab: ${tab.success ? "ok" : tab.error.message}`);
  if (!tab.success) process.exit(1);
  await sleep(500);

  // Force a non-16:9 window so S8's letterboxing is actually exercised, and remember the bounds to restore them.
  const current = client.current();
  let windowId: number | undefined;
  let originalBounds: unknown;
  if (current) {
    const wid = await client.session().windowId(current.targetId);
    if (wid.success) {
      windowId = wid.data;
      const bounds = await client.session().callBrowser("Browser.getWindowBounds", { windowId: wid.data });
      if (bounds.success) originalBounds = bounds.data.bounds;
      await client.session().callBrowser("Browser.setWindowBounds", {
        windowId: wid.data,
        bounds: { width: 900, height: 600, windowState: "normal" },
      });
      await sleep(500);
    }
  }
  check(windowId !== undefined, "resolved the fixture tab's window id");

  // --- S7 / S8: capture, encode, and letterbox check ---
  const recordStart = Date.now();
  const startResult = await recordStartTool.handler({}, ctx);
  check(startResult.success, `browser_record_start succeeded: ${startResult.success ? "ok" : startResult.error.message}`);
  if (!startResult.success) process.exit(1);
  const outputPath = (startResult.data.details as Record<string, unknown>)["path"] as string;

  await sleep(4000);

  const stopResult = await recordStopTool.handler({}, ctx);
  const wallClockSec = (Date.now() - recordStart) / 1000;
  check(stopResult.success, `browser_record_stop succeeded: ${stopResult.success ? "ok" : (stopResult as { success: false; error: { message: string } }).error.message}`);
  if (!stopResult.success) process.exit(1);

  check(existsSync(outputPath), `output file exists: ${outputPath}`);
  const size = statSync(outputPath).size;
  check(size > 0, `output file is non-empty (${size} bytes)`);

  const meta = await ffprobeJson(outputPath);
  const v = meta.streams.find((s: { codec_type: string }) => s.codec_type === "video");
  check(meta.format?.format_name?.includes("mp4"), `container is mp4 (got ${meta.format?.format_name})`);
  check(v?.codec_name === "h264", `video codec is h264 (got ${v?.codec_name})`);
  check(v?.width === 1280 && v?.height === 720, `frame is 1280x720 (got ${v?.width}x${v?.height})`);
  const avgFps = parseFrameRate(v?.avg_frame_rate);
  check(Math.abs(avgFps - 15) < 0.5, `average frame rate is ~15fps (got ${v?.avg_frame_rate})`);

  const durationSec = Number(meta.format?.duration ?? 0);
  const withinTolerance = Math.abs(durationSec - wallClockSec) <= wallClockSec * 0.2;
  check(withinTolerance, `duration ${durationSec.toFixed(2)}s is within 20% of wall clock ${wallClockSec.toFixed(2)}s`);

  try {
    const midSec = Math.min(2, Math.max(0.1, durationSec / 2));
    const pixels = await readFramePixels(outputPath, 1280, 720, midSec);
    const corner = pixelAt(pixels, 1280, 5, 5);
    const centre = pixelAt(pixels, 1280, 640, 360);
    const cornerIsBlack = corner[0] < 20 && corner[1] < 20 && corner[2] < 20;
    const centreIsPageColor = centre[0] > 180 && centre[2] < 100;
    check(cornerIsBlack, `frame corner is padded black (got rgb(${corner.join(",")}))`);
    check(centreIsPageColor, `frame centre shows page content, not cropped (got rgb(${centre.join(",")}))`);
  } catch (e) {
    check(false, `could not decode a frame to verify letterboxing: ${e instanceof Error ? e.message : String(e)}`);
  }

  // --- NF3 / S21: an abrupt termination still leaves a playable file. ---
  // The harness process itself cannot be killed from within its own test run, so this approximates
  // "the process dies mid-recording" by killing the encoder subprocess directly — the same failure
  // mode the container flags (+frag_keyframe+empty_moov) are meant to survive.
  {
    const abruptStart = await recordStartTool.handler({}, ctx);
    check(abruptStart.success, "S21 setup: started a second recording");
    if (abruptStart.success) {
      const abruptPath = (abruptStart.data.details as Record<string, unknown>)["path"] as string;
      // Long enough to clear the encoder's startup probe plus a full -g (1s) GOP with margin — a
      // keyframe fragment needs to actually land before killing the process can prove anything.
      await sleep(6000);
      try {
        await execFileP("pkill", ["-9", "-f", abruptPath]);
      } catch {
        // pkill exits non-zero when no process matched — irrelevant to the assertion below.
      }
      await sleep(1000);
      check(existsSync(abruptPath), `S21: a partial file exists after the encoder is killed: ${abruptPath}`);
      if (existsSync(abruptPath)) {
        try {
          const partialMeta = await ffprobeJson(abruptPath);
          const partialDuration = Number(partialMeta.format?.duration ?? 0);
          check(partialDuration > 0, `S21: the partial file reports a duration greater than zero (${partialDuration}s)`);
        } catch (e) {
          check(false, `S21: the partial file did not open in ffprobe: ${e instanceof Error ? e.message : String(e)}`);
        }
      }
      // The session still thinks a recording is active (the encoder died out from under it); clear it so cleanup below doesn't hang.
      client.session().stopRecording();
    }
  }

  // --- Cleanup ---
  if (windowId !== undefined && originalBounds && typeof originalBounds === "object") {
    const b = originalBounds as { width?: number; height?: number; left?: number; top?: number };
    if (b.width && b.height) {
      await client.session().callBrowser("Browser.setWindowBounds", {
        windowId,
        bounds: { width: b.width, height: b.height, ...(b.left !== undefined ? { left: b.left } : {}), ...(b.top !== undefined ? { top: b.top } : {}) },
      });
    }
  }
  if (tab.success) await client.closeTab(tab.data);
  await client.stop();
  await rm(recordingsDir, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("FATAL:", e);
  process.exit(1);
});
