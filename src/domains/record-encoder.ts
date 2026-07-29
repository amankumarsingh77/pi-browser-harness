import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { rename, rm, stat, writeFile } from "node:fs/promises";
import { delimiter, join } from "node:path";
import { type Result, err, ok } from "../util/result";
import type { ToolErr } from "../util/tool";

export type CursorPoint = {
  readonly t: number;
  readonly x: number;
  readonly y: number;
  readonly kind: "move" | "click";
};

export type Encoder = {
  write(jpeg: Buffer): void;
  setCursor(point: CursorPoint): void;
  close(): Promise<{
    readonly bytes: number;
    readonly durationSec: number;
    readonly cursorFailed: string | null;
  }>;
};

const CURSOR_SIZE = 14;
const FLASH_SIZE = 40;
// Long enough to read at 15fps (five frames — three was easy to miss entirely between samples),
// short enough that two nearby clicks stay distinct.
const FLASH_SECONDS = 0.35;

// sendcmd's script: commands sharing a timestamp are comma-separated WITHOUT repeating the
// timestamp. Repeating it is a parse error that kills the whole graph before a frame is written
// (docs/ARCHITECTURE.md). Entries must also be in ascending time order.
export const buildCursorScript = (track: readonly CursorPoint[]): string => {
  const entries: { readonly t: number; readonly cmds: readonly string[] }[] = [];
  for (const p of track) {
    const x = Math.round(p.x);
    const y = Math.round(p.y);
    const cmds = [`overlay@cur x ${String(x)}`, `overlay@cur y ${String(y)}`];
    if (p.kind === "click") {
      const fx = x - Math.round((FLASH_SIZE - CURSOR_SIZE) / 2);
      const fy = y - Math.round((FLASH_SIZE - CURSOR_SIZE) / 2);
      entries.push({
        t: p.t,
        cmds: [...cmds, `overlay@flash x ${String(fx)}`, `overlay@flash y ${String(fy)}`, "colorchannelmixer@flash aa 0.8"],
      });
      entries.push({ t: p.t + FLASH_SECONDS, cmds: ["colorchannelmixer@flash aa 0"] });
      continue;
    }
    entries.push({ t: p.t, cmds });
  }
  entries.sort((a, b) => a.t - b.t);
  return entries.map((e) => `${e.t.toFixed(3)} ${e.cmds.join(", ")};`).join("\n");
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
  const track: CursorPoint[] = [];

  return ok({
    write(jpeg) {
      framesWritten += 1;
      // Push and drop — never accumulate (NF2).
      child.stdin.write(jpeg);
    },
    setCursor(point) {
      // Coordinates and a timestamp only — a few dozen bytes per entry, so retaining the track for
      // the recording's life does not conflict with the no-buffering rule that governs frames (NF2).
      track.push(point);
    },
    async close() {
      if (!child.stdin.destroyed) child.stdin.end();
      const code = await new Promise<number | null>((resolve) => {
        child.on("close", resolve);
      });
      if (code !== 0 || failure !== null) {
        throw new Error(failure ?? `ffmpeg exited with code ${String(code)}: ${stderrTail}`);
      }
      const cursorFailed = track.length === 0 ? null : await compositeCursor(ffmpeg.data, opts, track);
      const stats = await stat(opts.outputPath);
      return { bytes: stats.size, durationSec: framesWritten / opts.fps, cursorFailed };
    },
  });
};

// The cursor is composited in a SECOND pass, at finalize, because sendcmd parses its script once at
// graph-construction time — commands appended to the file while ffmpeg runs are silently ignored
// (measured, not assumed; see docs/ARCHITECTURE.md). The track only exists once the recording ends,
// so a live overlay is not available to us.
//
// Pass 1 therefore writes the REAL output path, not a temp file: a recording killed mid-flight must
// still leave a playable file (NF3), which it would not if the real path only appeared at stop. This
// pass reads that file, composites, and renames over it.
const compositeCursor = async (
  ffmpeg: string,
  opts: CreateEncoderOpts,
  track: readonly CursorPoint[],
): Promise<string | null> => {
  const scriptPath = `${opts.outputPath}.cursor.txt`;
  const compositedPath = `${opts.outputPath}.cursor.mp4`;
  try {
    await writeFile(scriptPath, buildCursorScript(track), "utf8");

    // shortest=1 belongs on the overlay filter itself: -shortest does NOT govern a filter graph, and
    // the sprite sources below are endless, so without it ffmpeg never reaches EOF and hangs forever.
    // eval=frame is what makes the x/y commands take effect per frame rather than being fixed when
    // the graph is built. Both were silent hangs / silently wrong output, never an error message.
    const filter = [
      `[0:v]sendcmd=f='${scriptPath}'[base]`,
      `[1:v]format=rgba,colorchannelmixer@flash=aa=0[fl]`,
      `[2:v]format=rgba,colorchannelmixer=aa=0.95[cur]`,
      `[base][fl]overlay@flash=x=-${String(FLASH_SIZE)}:y=-${String(FLASH_SIZE)}:eval=frame:shortest=1[withflash]`,
      `[withflash][cur]overlay@cur=x=-${String(CURSOR_SIZE)}:y=-${String(CURSOR_SIZE)}:eval=frame:shortest=1[out]`,
    ].join(";");

    await new Promise<void>((resolve, reject) => {
      const pass2 = spawn(
        ffmpeg,
        [
          "-hide_banner", "-loglevel", "error", "-y",
          "-i", opts.outputPath,
          "-f", "lavfi", "-i", `color=c=yellow:s=${String(FLASH_SIZE)}x${String(FLASH_SIZE)}:r=${String(opts.fps)}`,
          "-f", "lavfi", "-i", `color=c=white:s=${String(CURSOR_SIZE)}x${String(CURSOR_SIZE)}:r=${String(opts.fps)}`,
          "-filter_complex", filter,
          "-map", "[out]",
          "-c:v", "libx264", "-preset", "veryfast", "-crf", "23", "-pix_fmt", "yuv420p",
          compositedPath,
        ],
        { stdio: ["ignore", "ignore", "pipe"] },
      );
      let tail = "";
      pass2.stderr?.on("data", (c: Buffer) => {
        tail = (tail + c.toString()).slice(-2000);
      });
      pass2.on("error", (e) => reject(new Error(e.message)));
      pass2.on("close", (code) => {
        if (code === 0) resolve();
        else reject(new Error(`cursor pass exited with code ${String(code)}: ${tail}`));
      });
    });

    await rename(compositedPath, opts.outputPath);
    return null;
  } catch (e) {
    // A failed overlay must not cost the recording: the cursor-less file at outputPath is still the
    // real capture, and losing it to a cosmetic pass would be the worse trade.
    return e instanceof Error ? e.message : String(e);
  } finally {
    await rm(scriptPath, { force: true }).catch(() => {});
    await rm(compositedPath, { force: true }).catch(() => {});
  }
};
