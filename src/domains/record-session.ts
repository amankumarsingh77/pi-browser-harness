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

export type CreateRecordingSinkOpts = {
  readonly maxSeconds?: number;
};

const CANVAS_WIDTH = 1280;
const CANVAS_HEIGHT = 720;
const FPS = 15;

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

  let framesReceived = 0;
  let finalized = false;
  // Chrome's screencast delivers frames on repaint (measured ~60fps in library-probe.md), far above
  // the 15fps the encoder was told to expect via -framerate. Forwarding every frame would make
  // ffmpeg encode each one as 1/15s of video, inflating the file's duration well past wall clock.
  // The constant-rate pump that repeats a frame during an idle gap is slice 2 (frozen-time
  // accounting); this is the narrower fix slice 1 needs — drop, never repeat — so the encoder's
  // frame count already tracks elapsed time.
  const minIntervalMs = 1000 / FPS;
  let lastForwardedAt: number | null = null;

  const sink: RecordingSink = {
    outputPath,
    onFrame(data) {
      framesReceived += 1;
      const now = Date.now();
      if (lastForwardedAt !== null && now - lastForwardedAt < minIntervalMs) return;
      lastForwardedAt = now;
      encoder.write(Buffer.from(data, "base64"));
    },
    noteInput(_x, _y, _kind) {
      // No-op stub until slice 4 wires the cursor track.
    },
    noteConsumerRestart() {
      // No-op stub until slice 2 wires frozen-time accounting.
    },
    async finalize(_reason: StopReason): Promise<Result<RecordingSummary, RecordingFinalizeError>> {
      if (finalized) return err({ message: "recording was already finalized" });
      finalized = true;
      try {
        const { bytes, durationSec } = await encoder.close();
        return ok({
          path: outputPath,
          durationSec,
          bytes,
          truncated: false,
          frozenSec: 0,
          framesReceived,
        });
      } catch (e) {
        return err({ message: e instanceof Error ? e.message : String(e) });
      }
    },
  };

  return ok(sink);
};
