---
title: "ffmpeg's sendcmd filter parses its script once at graph-construction time"
date: 2026-07-30
category: integration-issues
tags: [ffmpeg, sendcmd, overlay, video-encoding, streaming]
component: record-encoder
severity: medium
status: implemented
applies_to: ["src/domains/record-encoder.ts"]
stage: [code]
evidence_count: 1
last_validated: 2026-07-30
source: manual@add-feature-to-record-video
related: ["docs/ARCHITECTURE.md"]
---

# ffmpeg's sendcmd filter parses its script once at graph-construction time

## Problem

A cursor/click overlay was implemented by writing timed `overlay@cur x/y` commands into a
`sendcmd` script file while ffmpeg was already running, on the assumption that ffmpeg would
poll the file like a live log. It didn't: every command after the graph was built was silently
ignored — no error, no warning, just a cursor that never moved.

## Insight

**`sendcmd`'s script is parsed once, when the filter graph is constructed — not read
incrementally while the graph runs.** Anything appended to the script file after ffmpeg has
started processing is invisible to that run, with no diagnostic to indicate that. This is easy
to miss because sendcmd's manual describes commands as "sent" at a timestamp, which reads like
a live trigger rather than a fixed table baked in at start.

The practical consequence: any encoder feature that needs to react to information only known
partway through or after the recording (cursor position, click events, chapter markers, live
annotations) cannot be driven by streaming into a single sendcmd script during a single ffmpeg
invocation.

## Solution

Split the work into two passes instead of one live overlay:

```ts
// file: src/domains/record-encoder.ts
// Pass 1 writes the REAL output path (not a temp file) — a recording killed mid-flight must
// still leave a playable file, which it would not if the real path only appeared at stop.
// Pass 2, at finalize, reads that file, composites the cursor track (now fully known) via a
// complete sendcmd script written up front, and renames over the original.
const compositeCursor = async (
  ffmpeg: string,
  opts: CreateEncoderOpts,
  track: readonly CursorPoint[],
): Promise<string | null> => {
  const scriptPath = `${opts.outputPath}.cursor.txt`;
  await writeFile(scriptPath, buildCursorScript(track), "utf8"); // script complete before ffmpeg starts
  // ... second ffmpeg invocation reads scriptPath as a static, complete script
};
```

## Prevention / Reuse

- Never treat a `sendcmd` script as an append-while-running channel — write it complete,
  then start (or restart) the ffmpeg process that consumes it.
- If a feature needs to react to data only available partway through a live encode, use a
  two-pass design: pass 1 produces the base output (so a mid-flight kill still leaves something
  playable), pass 2 re-reads and composites once all data is known.
- Two further silent-parse-error traps in the same script format, worth checking alongside
  this one: commands sharing a timestamp must be comma-separated **without** repeating the
  timestamp (repeating it is a parse error that kills the whole graph before a frame is
  written), and entries must be in ascending time order.

## Related

- `docs/ARCHITECTURE.md` — the project's existing sendcmd notes (timestamp/ordering rules)
- `src/domains/record-encoder.ts` — `buildCursorScript`, `compositeCursor`
