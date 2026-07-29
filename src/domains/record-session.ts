import { mkdir } from "node:fs/promises";
import { dirname } from "node:path";
import type { BrowserClient } from "../client";
import type {
  RecordingFinalizeError,
  RecordingSink,
  RecordingSummary,
  StopReason,
} from "../cdp/types";
import { type Result, err, ok } from "../util/result";
import type { ToolErr } from "../util/tool";
import { recordingPath } from "../util/paths";
import { createEncoder } from "./record-encoder";
import { cdpCallBrowser } from "./cdp-call";

export type CreateRecordingSinkOpts = {
  readonly maxSeconds?: number;
};

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const FPS = 15;
// Far outside any real display on the platforms this was probed against (library-probe.md) — moves
// the window off every monitor without touching windowState, which is what keeps Chrome compositing it.
const OFFSCREEN_LEFT = -4000;
const OFFSCREEN_TOP = -4000;

type WindowParkResult = {
  readonly parked: boolean;
  readonly restore: () => Promise<void>;
};

// Park the recorded tab's window off-screen (R9). Any failure along the way — no window id, an
// unreadable current bounds, a rejected setWindowBounds — leaves the window where it is rather
// than failing the recording (EC4): a recording of a visible window beats no recording at all.
const parkWindow = async (client: BrowserClient): Promise<WindowParkResult> => {
  const noop: WindowParkResult = { parked: false, restore: () => Promise.resolve() };
  const targetId = client.current()?.targetId;
  if (targetId === undefined) return noop;

  const winIdResult = await client.session().windowId(targetId);
  if (!winIdResult.success) return noop;
  const windowId = winIdResult.data;

  const boundsResult = await cdpCallBrowser(client, "Browser.getWindowBounds", { windowId });
  if (!boundsResult.success) return noop;
  const { left, top, width, height } = boundsResult.data.bounds;
  if (left === undefined || top === undefined || width === undefined || height === undefined) return noop;

  // windowState must be set to "normal" in the same call that moves the window: a minimized window
  // won't move otherwise, and CDP rejects a bounds change paired with a non-normal state
  // (docs/ARCHITECTURE.md).
  const parkResult = await cdpCallBrowser(client, "Browser.setWindowBounds", {
    windowId,
    bounds: { windowState: "normal", left: OFFSCREEN_LEFT, top: OFFSCREEN_TOP, width, height },
  });
  if (!parkResult.success) return noop;

  return {
    parked: true,
    restore: async () => {
      // A closed tab means there is nothing left to restore — skip silently.
      await cdpCallBrowser(client, "Browser.setWindowBounds", {
        windowId,
        bounds: { windowState: "normal", left, top, width, height },
      });
    },
  };
};

// Mirrors src/domains/screenshot-capture.ts: a helper-only module beside the tool file, exporting plain async functions returning Result.
export const createRecordingSink = async (
  client: BrowserClient,
  _opts: CreateRecordingSinkOpts,
): Promise<Result<RecordingSink, ToolErr>> => {
  const outputPath = recordingPath(client.namespace);
  try {
    await mkdir(dirname(outputPath), { recursive: true });
  } catch (e) {
    return err({
      kind: "io_error",
      message: `could not create the recordings directory: ${e instanceof Error ? e.message : String(e)}`,
      details: { path: dirname(outputPath) },
    });
  }

  const encoderResult = createEncoder({
    outputPath,
    width: CANVAS_WIDTH,
    height: CANVAS_HEIGHT,
    fps: FPS,
  });
  if (!encoderResult.success) return encoderResult;
  const encoder = encoderResult.data;

  const park = await parkWindow(client);

  let framesReceived = 0;
  let finalized = false;

  // Cumulative rounding anchored at the first frame (docs/ARCHITECTURE.md): the frame index at
  // wall-clock time `t` is round(FPS * (t - anchor)), never the per-gap rounding that drops frames
  // under fast capture. `lastIndex` starts below zero so the very first frame is always written once.
  const minIntervalMs = 1000 / FPS;
  let anchorMs: number | null = null;
  let latestFrame: Buffer | null = null;
  let frameAtLastWrite: Buffer | null = null;
  let lastIndex = -1;
  let frozenMs = 0;
  let pumpTimer: NodeJS.Timeout | null = null;

  // Called both when a new frame arrives and on every pump tick — a tick with no new frame since
  // the last write repeats the latest frame and counts as frozen wall time (R11, R12); a tick that
  // caught a fresh frame does not.
  const catchUpTo = (nowMs: number): void => {
    if (anchorMs === null || latestFrame === null) return;
    const targetIndex = Math.round((FPS * (nowMs - anchorMs)) / 1000);
    if (targetIndex <= lastIndex) return;
    if (latestFrame === frameAtLastWrite) frozenMs += (targetIndex - lastIndex) * minIntervalMs;
    while (lastIndex < targetIndex) {
      encoder.write(latestFrame);
      lastIndex += 1;
    }
    frameAtLastWrite = latestFrame;
  };

  const sink: RecordingSink = {
    outputPath,
    parked: park.parked,
    onFrame(data) {
      framesReceived += 1;
      latestFrame = Buffer.from(data, "base64");
      if (anchorMs === null) {
        anchorMs = Date.now();
        pumpTimer = setInterval(() => catchUpTo(Date.now()), minIntervalMs);
        pumpTimer.unref();
      }
      catchUpTo(Date.now());
    },
    noteInput(_x, _y, _kind) {
      // No-op stub until slice 4 wires the cursor track.
    },
    noteConsumerRestart() {
      // restartConsumer's own outage duration isn't observable from here, so fold in one frame
      // period as a lower-bound signal — an underestimate beats the freeze masquerading as a
      // healthy stream (docs/ARCHITECTURE.md).
      frozenMs += minIntervalMs;
    },
    async finalize(_reason: StopReason): Promise<Result<RecordingSummary, RecordingFinalizeError>> {
      if (finalized) return err({ message: "recording was already finalized" });
      finalized = true;
      // Restoration runs even when the recording is ending on an error or the duration cap, so it
      // has to happen before the encoder is touched, not only on the success path.
      await park.restore();
      catchUpTo(Date.now());
      if (pumpTimer) clearInterval(pumpTimer);
      try {
        const { bytes, durationSec } = await encoder.close();
        return ok({
          path: outputPath,
          durationSec,
          bytes,
          truncated: false,
          frozenSec: frozenMs / 1000,
          framesReceived,
        });
      } catch (e) {
        return err({ message: e instanceof Error ? e.message : String(e) });
      }
    },
  };

  return ok(sink);
};
