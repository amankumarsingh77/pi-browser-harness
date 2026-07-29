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

    return ok({
      text: `Recording to ${sinkResult.data.outputPath}`,
      details: { path: sinkResult.data.outputPath },
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

    return ok({
      text: `Recording saved: ${summary.data.path} (${summary.data.durationSec.toFixed(1)}s, ${summary.data.bytes} bytes)`,
      details: { ...summary.data },
    });
  },
});
