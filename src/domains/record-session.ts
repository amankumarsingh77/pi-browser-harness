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
// R18: a recording nobody stops must not write forever.
export const DEFAULT_MAX_SECONDS = 300;
// Far outside any real display on the platforms this was probed against (library-probe.md) — moves
// the window off every monitor without touching windowState, which is what keeps Chrome compositing it.
const OFFSCREEN_LEFT = -4000;
const OFFSCREEN_TOP = -4000;

// Input coordinates arrive in the page's viewport space, but frames are scaled to fit a fixed canvas
// and letterboxed. A pointer drawn at raw viewport coordinates drifts out of alignment on any tab
// whose size differs from the canvas — so every point goes through the SAME scale and offset the
// encoder's scale/pad chain applies to the frames themselves.
export const toCanvasPoint = (
  x: number,
  y: number,
  sourceWidth: number,
  sourceHeight: number,
): { readonly x: number; readonly y: number } => {
  // Unknown source dimensions must not produce NaN coordinates that would poison the cursor script.
  if (sourceWidth <= 0 || sourceHeight <= 0) return { x: 0, y: 0 };
  const scale = Math.min(CANVAS_WIDTH / sourceWidth, CANVAS_HEIGHT / sourceHeight);
  const offsetX = (CANVAS_WIDTH - sourceWidth * scale) / 2;
  const offsetY = (CANVAS_HEIGHT - sourceHeight * scale) / 2;
  return { x: Math.round(x * scale + offsetX), y: Math.round(y * scale + offsetY) };
};

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
  opts: CreateRecordingSinkOpts,
): Promise<Result<RecordingSink, ToolErr>> => {
  const maxSeconds = opts.maxSeconds ?? DEFAULT_MAX_SECONDS;
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
  let sourceWidth: number | null = null;
  let sourceHeight: number | null = null;
  let sourceLost: string | null = null;
  // The LATEST dimensions, unlike the first-frame pair above: a tab switch changes the source size
  // mid-recording (R13), and a pointer must be transformed against the tab it was actually on.
  let currentSourceWidth: number | null = null;
  let currentSourceHeight: number | null = null;
  let cursorPoints = 0;
  let cursorClicks = 0;
  let lastSummary: RecordingSummary | null = null;

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
    onFrame(data, sourceDims) {
      framesReceived += 1;
      // The first frame's dims only — later frames legitimately change on a tab switch (R13), and
      // the summary reports where the recording started, not a running value.
      if (sourceWidth === null && sourceDims) {
        sourceWidth = sourceDims.width;
        sourceHeight = sourceDims.height;
      }
      if (sourceDims) {
        currentSourceWidth = sourceDims.width;
        currentSourceHeight = sourceDims.height;
      }
      latestFrame = Buffer.from(data, "base64");
      if (anchorMs === null) {
        anchorMs = Date.now();
        pumpTimer = setInterval(() => catchUpTo(Date.now()), minIntervalMs);
        pumpTimer.unref();
      }
      catchUpTo(Date.now());
    },
    noteInput(x, y, kind) {
      if (finalized) return;
      cursorPoints += 1;
      if (kind === "click") cursorClicks += 1;
      // Timestamps are relative to the first frame, which is what anchors the video's own timeline —
      // anything before that frame belongs at t=0 rather than at a negative offset.
      const t = anchorMs === null ? 0 : Math.max(0, (Date.now() - anchorMs) / 1000);
      const point = toCanvasPoint(x, y, currentSourceWidth ?? 0, currentSourceHeight ?? 0);
      encoder.setCursor({ t, x: point.x, y: point.y, kind });
    },
    noteConsumerRestart() {
      // restartConsumer's own outage duration isn't observable from here, so fold in one frame
      // period as a lower-bound signal — an underestimate beats the freeze masquerading as a
      // healthy stream (docs/ARCHITECTURE.md).
      frozenMs += minIntervalMs;
    },
    noteSourceLost(reason) {
      // First cause wins — a tab-switch resubscribe failure (R13) or the recorded tab closing
      // (EC1) both mean the same thing downstream (the pump is now repeating frames), so whichever
      // is reported first is the one worth keeping.
      if (sourceLost === null) sourceLost = reason;
    },
    async finalize(reason: StopReason): Promise<Result<RecordingSummary, RecordingFinalizeError>> {
      if (finalized) return err({ message: "recording was already finalized" });
      finalized = true;
      // Cleared here, not only on the cap path: a normal stop must not leave the cap's timer
      // pending and firing a second "capped" finalize on an already-finalized sink.
      if (capTimer) clearTimeout(capTimer);
      // Restoration runs even when the recording is ending on an error or the duration cap, so it
      // has to happen before the encoder is touched, not only on the success path.
      await park.restore();
      catchUpTo(Date.now());
      if (pumpTimer) clearInterval(pumpTimer);
      try {
        const { bytes, durationSec, cursorFailed } = await encoder.close();
        const summary: RecordingSummary = {
          path: outputPath,
          durationSec,
          bytes,
          truncated: reason === "capped",
          frozenSec: frozenMs / 1000,
          framesReceived,
          sourceWidth,
          sourceHeight,
          sourceLost,
          cursorPoints,
          cursorClicks,
          cursorFailed,
        };
        lastSummary = summary;
        return ok(summary);
      } catch (e) {
        return err({ message: e instanceof Error ? e.message : String(e) });
      }
    },
    lastSummary() {
      return lastSummary;
    },
  };

  // Armed after `sink` exists so the callback can finalize through the same object a caller would
  // (docs/ARCHITECTURE.md) — cleared inside finalize regardless of how the recording actually ends.
  // unref() so a pending cap never holds the process alive on its own.
  const capTimer = setTimeout(() => {
    void sink.finalize("capped");
  }, maxSeconds * 1000);
  capTimer.unref();

  return ok(sink);
};
