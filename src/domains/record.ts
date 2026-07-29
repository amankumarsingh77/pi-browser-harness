import { Type } from "typebox";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { cdpErrToToolErr } from "./cdp-call";
import { createRecordingSink } from "./record-session";

const RecordStartArgs = Type.Object({
  maxSeconds: Type.Optional(
    Type.Integer({
      minimum: 1,
      description: "Duration cap in seconds before the recording finalizes itself and reports truncated. Defaults to 300.",
    }),
  ),
});

export const recordStartTool = defineBrowserTool({
  name: "browser_record_start",
  label: "Browser Record Start",
  description:
    "Start recording the current tab to an MP4 file. The recording follows the agent across tab switches until browser_record_stop is called.",
  promptSnippet: "Start recording the browser session to video",
  promptGuidelines: [
    "Use to capture a bug repro or demo as a shareable video, not for anything the agent itself needs to read back.",
    "Only one recording can be active per session — call browser_record_stop before starting another.",
    "Pair with browser_record_stop to finish the file and get its path, duration, and size.",
  ],
  parameters: RecordStartArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const active = client.session().activeRecording();
    if (active) {
      return err({
        kind: "invalid_state",
        message: `a recording is already active: ${active.outputPath}`,
        details: { path: active.outputPath },
      });
    }

    const sinkResult = await createRecordingSink(client, {
      ...(args.maxSeconds !== undefined ? { maxSeconds: args.maxSeconds } : {}),
    });
    if (!sinkResult.success) return sinkResult;

    const started = await client.session().startRecording(sinkResult.data);
    if (!started.success) return err(cdpErrToToolErr(started.error, "Page.startScreencast"));

    const windowNote = sinkResult.data.parked
      ? " The window has been parked off-screen for the duration and will be restored on stop."
      : " The window could not be moved off-screen — leave it visible for the duration of the recording.";

    return ok({
      text: `Recording to ${sinkResult.data.outputPath}${windowNote}`,
      details: { path: sinkResult.data.outputPath, parked: sinkResult.data.parked },
    });
  },
});

export const recordStopTool = defineBrowserTool({
  name: "browser_record_stop",
  label: "Browser Record Stop",
  description: "Stop the active recording and finalize the MP4 file.",
  promptSnippet: "Stop recording and get the finished video",
  promptGuidelines: [
    "Returns the file path, duration in seconds, and size in bytes once the recording is finalized.",
    "Fails with invalid_state if no recording is active.",
  ],
  parameters: Type.Object({}),
  concurrency: "serialized",
  async handler(_args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const sink = client.session().stopRecording();
    if (!sink) {
      return err({ kind: "invalid_state", message: "no recording is active" });
    }

    const summary = await sink.finalize("stopped");
    if (!summary.success) {
      return err({
        kind: "io_error",
        message: `the recording encoder failed: ${summary.error.message}`,
      });
    }

    const frozenNote =
      summary.data.frozenSec > 1
        ? ` — ${summary.data.frozenSec.toFixed(1)}s of that had no frames arriving (window frozen or hidden)`
        : "";
    const sourceLostNote =
      summary.data.sourceLost !== null ? ` — lost its source and could not resume: ${summary.data.sourceLost}` : "";

    // A missing pointer is worth saying out loud: the video is still the real capture, but someone
    // watching it to see where the agent clicked would otherwise just find nothing there.
    const cursorNote =
      summary.data.cursorFailed !== null
        ? ` — the video is intact but the cursor overlay could not be drawn: ${summary.data.cursorFailed}`
        : "";

    return ok({
      text: `Recording saved: ${summary.data.path} (${summary.data.durationSec.toFixed(1)}s, ${summary.data.bytes} bytes)${frozenNote}${sourceLostNote}${cursorNote}`,
      details: { ...summary.data },
    });
  },
});
