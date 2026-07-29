import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { stat } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { type Result, err, ok } from "../util/result";
import type { ToolErr } from "../util/tool";

export type Encoder = {
  write(jpeg: Buffer): void;
  close(): Promise<{ readonly bytes: number; readonly durationSec: number }>;
};

export type CreateEncoderOpts = {
  readonly outputPath: string;
  readonly width: number;
  readonly height: number;
  readonly fps: number;
};

const FFMPEG_INSTALL_HINT =
  "ffmpeg was not found on PATH — install it (apt install ffmpeg / brew install ffmpeg) to record video";

// Follows src/util/sharp-shim.ts's shape: report absence as a value, never throw.
export const resolveFfmpeg = (): Result<string, ToolErr> => {
  const pathVar = process.env["PATH"] ?? "";
  const exeNames = process.platform === "win32" ? ["ffmpeg.exe"] : ["ffmpeg"];
  for (const dir of pathVar.split(delimiter)) {
    if (!dir) continue;
    for (const exe of exeNames) {
      const candidate = join(dir, exe);
      if (existsSync(candidate)) return ok(candidate);
    }
  }
  return err({ kind: "io_error", message: FFMPEG_INSTALL_HINT });
};

export const createEncoder = (opts: CreateEncoderOpts): Result<Encoder, ToolErr> => {
  const ffmpeg = resolveFfmpeg();
  if (!ffmpeg.success) return ffmpeg;

  const filter =
    `scale=${opts.width}:${opts.height}:force_original_aspect_ratio=decrease,` +
    `pad=${opts.width}:${opts.height}:(ow-iw)/2:(oh-ih)/2:black,fps=${opts.fps}`;

  // -framerate must precede -i, or ffmpeg silently ignores it and defaults to 25fps (docs/ARCHITECTURE.md).
  const child = spawn(
    ffmpeg.data,
    [
      "-hide_banner", "-loglevel", "error", "-y",
      // -vcodec mjpeg: without it, image2pipe cannot always find codec parameters for a raw JPEG stream on stdin and fails with "Could not find codec parameters".
      // -analyzeduration 0 -probesize 32: image2pipe's default probe (up to 5s of input) delays
      // opening the output file by that much even with -vcodec mjpeg already naming the codec —
      // a multi-second startup stall that looked like the whole pipeline was stuck.
      "-f", "image2pipe", "-vcodec", "mjpeg", "-framerate", String(opts.fps),
      "-analyzeduration", "0", "-probesize", "32", "-i", "pipe:0",
      "-thread_queue_size", "512",
      "-vf", filter,
      "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
      // -g <fps>: a keyframe roughly once a second. +frag_keyframe only emits a fragment at each
      // keyframe, so the default multi-second GOP left a killed process's file with no fragment at
      // all — just the ftyp box (NF3). -flush_packets forces each fragment to hit disk as it's
      // produced rather than sitting in libavformat's output buffer until a clean close.
      "-g", String(opts.fps),
      "-movflags", "+frag_keyframe+empty_moov",
      "-flush_packets", "1",
      opts.outputPath,
    ],
    { stdio: ["pipe", "ignore", "pipe"] },
  );

  let failure: string | null = null;
  // An EPIPE from a dead ffmpeg would otherwise surface as an unhandled stream error and crash the process (EC2).
  child.on("error", (e) => {
    failure = `ffmpeg process error: ${e.message}`;
  });
  child.stdin.on("error", (e) => {
    failure = `ffmpeg stdin error: ${e.message}`;
  });

  let stderrTail = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrTail = (stderrTail + chunk.toString()).slice(-2000);
  });

  let framesWritten = 0;

  return ok({
    write(jpeg) {
      framesWritten += 1;
      // Push and drop — never accumulate (NF2).
      child.stdin.write(jpeg);
    },
    async close() {
      if (!child.stdin.destroyed) child.stdin.end();
      const code = await new Promise<number | null>((resolve) => {
        child.on("close", resolve);
      });
      if (code !== 0 || failure !== null) {
        throw new Error(failure ?? `ffmpeg exited with code ${String(code)}: ${stderrTail}`);
      }
      const stats = await stat(opts.outputPath);
      return { bytes: stats.size, durationSec: framesWritten / opts.fps };
    },
  });
};
