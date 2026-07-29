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
import { cdpCall, evalJs } from "../../src/domains/cdp-call";
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

// A second, distinctly-colored fixture (blue, not red) so SV1 can tell which tab a decoded frame
// came from by sampling its centre pixel, the same way FIXTURE's corner/centre pair proves
// letterboxing. Needs the same requestAnimationFrame loop as FIXTURE: a page that paints once and
// then sits still gets exactly one screencast frame from Chrome, which makes "sample a frame after
// the switch" a race against whether that lone frame has arrived yet rather than a real check.
const FIXTURE2 = `<!doctype html><meta charset=utf-8>
<body style="margin:0;background:#0040ff;overflow:hidden">
<div id=t style="color:#fff;font:20px system-ui;padding:1rem"></div>
<script>
let n = 0;
function frame() {
  n++;
  document.getElementById('t').textContent = 'tab two frame ' + n + ' t=' + (performance.now() / 1000).toFixed(2) + 's';
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

  // --- S9 / S10 (phase 2): the window is parked off-screen for the duration and restored on stop. ---
  {
    const beforePark = windowId !== undefined
      ? await client.session().callBrowser("Browser.getWindowBounds", { windowId })
      : undefined;

    const parkStart = await recordStartTool.handler({}, ctx);
    check(parkStart.success, `S9 setup: browser_record_start succeeded: ${parkStart.success ? "ok" : parkStart.error.message}`);
    if (parkStart.success) {
      check(parkStart.data.details?.["parked"] === true, "S9: browser_record_start reports the window was parked");
      check(/parked off-screen/.test(parkStart.data.text), "S9: the start tool's text mentions the window was parked");

      await sleep(500);
      if (windowId !== undefined && beforePark?.success) {
        const parked = await client.session().callBrowser("Browser.getWindowBounds", { windowId });
        if (parked.success) {
          const b = parked.data.bounds;
          const before = beforePark.data.bounds;
          // -4000,-4000 is what the harness *requests* (proven exactly by the unit test against a
          // canned transport); this window manager visibly clamps a request that far off-screen back
          // onto the desktop (44,13 observed), so the live check asserts what CDP can actually promise
          // on this platform — the position moved and the size was preserved — not the exact
          // coordinate, which is a documented, platform-dependent risk (design.md "Risks & Assumptions").
          check(
            b.left !== before.left || b.top !== before.top,
            `S9: window position changed from its pre-recording spot (before=(${String(before.left)},${String(before.top)}), during=(${String(b.left)},${String(b.top)}))`,
          );
          check(b.windowState === "normal", `S9: window state stayed normal, not minimized (got ${String(b.windowState)})`);
          check(b.width === before.width && b.height === before.height, `S9: window kept its original size (${String(b.width)}x${String(b.height)})`);
        } else {
          check(false, "S9: could not read the parked window's bounds");
        }
      }

      const parkStop = await recordStopTool.handler({}, ctx);
      check(parkStop.success, `S10: browser_record_stop succeeded: ${parkStop.success ? "ok" : parkStop.error.message}`);

      if (windowId !== undefined && beforePark?.success) {
        await sleep(300);
        const restored = await client.session().callBrowser("Browser.getWindowBounds", { windowId });
        if (restored.success) {
          const before = beforePark.data.bounds;
          const after = restored.data.bounds;
          check(
            after.left === before.left && after.top === before.top && after.width === before.width && after.height === before.height,
            `S10: window restored to its pre-recording bounds (before=${JSON.stringify(before)}, after=${JSON.stringify(after)})`,
          );
        } else {
          check(false, "S10: could not read the restored window's bounds");
        }
      }
    }
  }

  // --- S11 / S12 (phase 2): a minimized window freezes capture without ending the recording, and the gap is reported. ---
  {
    const frozenStart = await recordStartTool.handler({}, ctx);
    check(frozenStart.success, `S11/S12 setup: browser_record_start succeeded: ${frozenStart.success ? "ok" : frozenStart.error.message}`);
    if (frozenStart.success) {
      await sleep(500);
      if (windowId !== undefined) {
        await client.session().callBrowser("Browser.setWindowBounds", { windowId, bounds: { windowState: "minimized" } });
      }
      await sleep(1500);
      check(client.session().activeRecording() !== null, "S11: the recording is still active through the frozen stretch");
      if (windowId !== undefined) {
        await client.session().callBrowser("Browser.setWindowBounds", {
          windowId,
          bounds: { windowState: "normal", left: -4000, top: -4000, width: 900, height: 600 },
        });
      }
      await sleep(500);

      const frozenStop = await recordStopTool.handler({}, ctx);
      check(frozenStop.success, `S11/S12: browser_record_stop succeeded: ${frozenStop.success ? "ok" : frozenStop.error.message}`);
      if (frozenStop.success) {
        const details = frozenStop.data.details as Record<string, unknown>;
        const frozenSec = details["frozenSec"] as number;
        check(frozenSec > 1, `S12: frozenSec reports the minimized stretch (${frozenSec}s)`);
        check(/frozen/i.test(frozenStop.data.text), "S12: the stop tool's text names the frozen duration");
        const outPath = details["path"] as string;
        check(existsSync(outPath) && statSync(outPath).size > 0, "S11: a file was still produced despite the frozen stretch");
      }
    }
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

  // --- SV1 (plan.md#system-verification): one recording spans two differently-sized tabs. ---
  // The fixture tab is still at 900x600 from the setup above. A second tab is opened — CDP tabs
  // share the harness's one window, so "differently sized" is achieved by resizing that window
  // between the two segments, not by two separate OS windows — and the switch to it is what
  // exercises switchTo's re-subscribe (R13). Content is told apart by fixture color: FIXTURE is
  // red, FIXTURE2 is blue.
  {
    const sv1Start = await recordStartTool.handler({}, ctx);
    check(sv1Start.success, `SV1 setup: browser_record_start succeeded: ${sv1Start.success ? "ok" : sv1Start.error.message}`);
    if (sv1Start.success) {
      const sv1Path = (sv1Start.data.details as Record<string, unknown>)["path"] as string;
      const sv1WallStart = Date.now();

      await sleep(2000); // drive the first (900x600, red) tab

      const tab2 = await client.newTab("data:text/html," + encodeURIComponent(FIXTURE2));
      check(tab2.success, `SV1: opened a second tab: ${tab2.success ? "ok" : tab2.error.message}`);
      const switchAtSec = (Date.now() - sv1WallStart) / 1000;

      if (tab2.success) {
        const cur2 = client.current();
        if (cur2) {
          const wid2 = await client.session().windowId(cur2.targetId);
          if (wid2.success) {
            await client.session().callBrowser("Browser.setWindowBounds", {
              windowId: wid2.data,
              bounds: { width: 1400, height: 900, windowState: "normal" },
            });
          }
        }
      }

      await sleep(2000); // drive the second (1400x900, blue) tab

      const sv1Stop = await recordStopTool.handler({}, ctx);
      const sv1WallClockSec = (Date.now() - sv1WallStart) / 1000;
      check(sv1Stop.success, `SV1: browser_record_stop succeeded: ${sv1Stop.success ? "ok" : (sv1Stop as { success: false; error: { message: string } }).error.message}`);

      if (sv1Stop.success) {
        const details = sv1Stop.data.details as Record<string, unknown>;
        check(details["sourceLost"] === null, `SV1: the resubscribe on switch succeeded — nothing was lost (got ${JSON.stringify(details["sourceLost"])})`);
        check(existsSync(sv1Path) && statSync(sv1Path).size > 0, `SV1: one file was produced, not two: ${sv1Path}`);

        const sv1Meta = await ffprobeJson(sv1Path);
        const sv1V = sv1Meta.streams.find((s: { codec_type: string }) => s.codec_type === "video");
        check(sv1V?.width === 1280 && sv1V?.height === 720, `SV1: every frame is 1280x720 (got ${sv1V?.width}x${sv1V?.height})`);

        const sv1Duration = Number(sv1Meta.format?.duration ?? 0);
        const withinTolerance = Math.abs(sv1Duration - sv1WallClockSec) <= sv1WallClockSec * 0.25;
        check(withinTolerance, `SV1: duration ${sv1Duration.toFixed(2)}s covers both tabs' activity (wall clock ${sv1WallClockSec.toFixed(2)}s)`);

        try {
          const earlySec = Math.min(1.0, Math.max(0.1, sv1Duration / 4));
          const earlyPixels = await readFramePixels(sv1Path, 1280, 720, earlySec);
          const earlyCentre = pixelAt(earlyPixels, 1280, 640, 360);
          const earlyCorner = pixelAt(earlyPixels, 1280, 5, 5);
          check(
            earlyCentre[0] > 180 && earlyCentre[2] < 100,
            `SV1: the early frame shows the first (red) tab's content (got rgb(${earlyCentre.join(",")}))`,
          );
          check(
            earlyCorner[0] < 20 && earlyCorner[1] < 20 && earlyCorner[2] < 20,
            `SV1: the first tab's 900x600 content is letterboxed, not cropped (corner rgb(${earlyCorner.join(",")}))`,
          );

          const lateSec = Math.min(sv1Duration - 0.1, Math.max(switchAtSec + 0.5, sv1Duration - 0.5));
          const latePixels = await readFramePixels(sv1Path, 1280, 720, lateSec);
          const lateCentre = pixelAt(latePixels, 1280, 640, 360);
          check(
            lateCentre[2] > 180 && lateCentre[0] < 100,
            `SV1: the frame after the switch point shows the second (blue) tab, with no gap in the timeline (got rgb(${lateCentre.join(",")}) at ${lateSec.toFixed(2)}s, switch was at ${switchAtSec.toFixed(2)}s)`,
          );
        } catch (e) {
          check(false, `SV1: could not decode frames to verify tab content: ${e instanceof Error ? e.message : String(e)}`);
        }
      }

      if (tab2.success) await client.closeTab(tab2.data);
    }
  }

  // --- S15 / S16 (phase 4): the composited pointer lands where the agent acted, and a click reads
  // differently from a move. Both are proven by decoding real frames, not by trusting the track. ---
  {
    // SV1 closed the tab it switched to, so the session is pointed at a destroyed target. Come back
    // to the fixture tab before recording, or the screencast subscribes against a dead session id.
    if (tab.success) await client.switchTab(tab.data);
    await sleep(300);

    const cursorStart = await recordStartTool.handler({}, ctx);
    check(cursorStart.success, `S15 setup: browser_record_start succeeded: ${cursorStart.success ? "ok" : cursorStart.error.message}`);

    if (cursorStart.success) {
      // Two well-separated clicks a couple of seconds apart, plus a move in between that must NOT flash.
      await sleep(700);
      await cdpCall(client, "Input.dispatchMouseEvent", { type: "mousePressed", x: 60, y: 60, button: "left", clickCount: 1 });
      await cdpCall(client, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 60, y: 60, button: "left", clickCount: 1 });
      await sleep(1600);
      await cdpCall(client, "Input.dispatchMouseEvent", { type: "mouseMoved", x: 500, y: 320, button: "none", clickCount: 0 });
      await sleep(1600);
      await cdpCall(client, "Input.dispatchMouseEvent", { type: "mousePressed", x: 700, y: 400, button: "left", clickCount: 1 });
      await cdpCall(client, "Input.dispatchMouseEvent", { type: "mouseReleased", x: 700, y: 400, button: "left", clickCount: 1 });
      await sleep(1200);

      const cursorStop = await recordStopTool.handler({}, ctx);
      check(cursorStop.success, `S15/S16: browser_record_stop succeeded: ${cursorStop.success ? "ok" : cursorStop.error.message}`);

      if (cursorStop.success) {
        const d = cursorStop.data.details as Record<string, unknown>;
        check(d["cursorFailed"] === null, `S15: the cursor overlay pass succeeded (got ${String(d["cursorFailed"])})`);
        check((d["cursorPoints"] as number) >= 3, `S15: every agent action reached the track (got ${String(d["cursorPoints"])})`);
        check(d["cursorClicks"] === 2, `S16: exactly the two presses were marked as clicks (got ${String(d["cursorClicks"])})`);

        const srcW = d["sourceWidth"] as number | null;
        const srcH = d["sourceHeight"] as number | null;
        check(srcW !== null && srcH !== null, `S15: the summary knows the source dimensions (${String(srcW)}x${String(srcH)})`);

        // The page itself must be untouched — a repro video of a page we modified is one someone can
        // argue with. Nothing was ever injected, so no overlay element can exist in the DOM.
        const domProbe = await evalJs(client, "document.querySelectorAll('[data-pi-cursor],[id*=\"pi-cursor\"]').length");
        check(domProbe.success && domProbe.data === 0, "S15: the page content is unmodified — no overlay element exists in the DOM");

        if (srcW && srcH) {
          const scale = Math.min(1280 / srcW, 720 / srcH);
          const expected = (vx: number, vy: number): [number, number] => [
            Math.round(vx * scale + (1280 - srcW * scale) / 2),
            Math.round(vy * scale + (720 - srcH * scale) / 2),
          ];
          // Near-white: the sprite. Near-yellow: the click flash. The fixtures are saturated red and
          // blue, so neither colour can come from the page itself. Count only pixels NEAR the point
          // being asserted — a whole-frame centroid is dragged off the sprite by any white page
          // content, which says nothing about where the pointer actually is.
          const countNear = (
            buf: Buffer, want: "white" | "yellow", ex: number, ey: number, radius: number,
          ): number => {
            let n = 0;
            for (let y = Math.max(0, ey - radius); y < Math.min(720, ey + radius); y++) {
              for (let x = Math.max(0, ex - radius); x < Math.min(1280, ex + radius); x++) {
                const [r, g, b] = pixelAt(buf, 1280, x, y);
                if (want === "white" ? r > 200 && g > 200 && b > 200 : r > 170 && g > 170 && b < 110) n++;
              }
            }
            return n;
          };
          const countAll = (buf: Buffer, want: "white" | "yellow"): number => countNear(buf, want, 640, 360, 900);

          const videoPath = cursorStop.data.details?.["path"] as string;
          // The track's t=0 is the first captured frame, which lags browser_record_start by an
          // unobservable amount — so scan a window around each action rather than betting on one
          // timestamp. Scanning is what makes this robust; a fixed sample was silently off by 0.3s.
          const scan = async (
            from: number, to: number, fn: (buf: Buffer) => number,
          ): Promise<{ best: number; atSec: number }> => {
            let best = 0, atSec = -1;
            for (let t = from; t <= to; t += 0.1) {
              const n = fn(await readFramePixels(videoPath, 1280, 720, t));
              if (n > best) { best = n; atSec = t; }
            }
            return { best, atSec };
          };

          try {
            const [ex1, ey1] = expected(60, 60);
            const [ex2, ey2] = expected(700, 400);

            const p1 = await scan(0.8, 1.8, (b) => countNear(b, "white", ex1, ey1, 25));
            check(p1.best > 0, `S15: a pointer marker is visible near the first click at ~(${String(ex1)},${String(ey1)}) (${String(p1.best)} px at ${p1.atSec.toFixed(1)}s)`);

            const p2 = await scan(4.0, 5.0, (b) => countNear(b, "white", ex2, ey2, 25));
            check(p2.best > 0, `S15: the pointer moved to the second click at ~(${String(ex2)},${String(ey2)}) (${String(p2.best)} px at ${p2.atSec.toFixed(1)}s)`);

            const flash1 = await scan(0.7, 1.5, (b) => countAll(b, "yellow"));
            check(flash1.best > 0, `S16: the frame at the click shows the flash (${String(flash1.best)} px at ${flash1.atSec.toFixed(1)}s)`);

            // The move happens in this window and no click does, so the flash must be absent throughout.
            const quiet = await scan(2.6, 3.4, (b) => countAll(b, "yellow"));
            check(quiet.best === 0, `S16: the frame during the move does not (${String(quiet.best)} px)`);

            const after = await scan(flash1.atSec + 0.6, flash1.atSec + 1.2, (b) => countAll(b, "yellow"));
            check(after.best === 0, `S16: the flash is gone again shortly after the click (${String(after.best)} px)`);
          } catch (e) {
            check(false, `S15/S16: could not decode frames to locate the pointer: ${e instanceof Error ? e.message : String(e)}`);
          }
        }
      }
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
