---
title: "A locked desktop session stops Chrome compositing exactly like a minimized window"
date: 2026-07-30
category: debugging
tags: [chrome, screencast, compositing, e2e, headed-browser, locked-session, false-regression]
component: e2e-recording
severity: medium
status: observed
applies_to: ["test/manual/*-test.ts"]
stage: [verify]
evidence_count: 1
last_validated: 2026-07-30
source: manual@add-feature-to-record-video
related: []
---

# A locked desktop session stops Chrome compositing exactly like a minimized window

## Problem

A live e2e recording run scored 41/54 instead of the expected 54/54, with failures that looked
like a genuine regression in frame delivery (frozen/missing frames). The actual cause was that
the desktop session running the browser had locked itself (screensaver/lock-screen) partway
through the run, not a code defect.

## Insight

**Chrome stops compositing — and therefore stops delivering `Page.screencastFrame` events —
when its desktop session is locked, exactly as it does when its window is minimized.** The
project's screencast pipeline already treats minimization as an expected, handled case
(frozen-stretch detection, S11/S12 in the record feature's test matrix); a locked session hits
the identical code path but looks, from the outside, like an unexplained drop in frame count
rather than a known "window not compositing" state, because nothing in the test output names
the session lock as the cause.

This is a genuine trap for any headed/live browser test run on a machine with a screen lock or
idle timeout: the failure signature (partial frame count, frozen stretches, or outright missing
frames) is indistinguishable from a real bug unless the operator remembers to check session
state first.

## Solution

Before diagnosing a live/e2e recording run that shows dropped or frozen frames, rule out a
locked session first:

```bash
loginctl unlock-session $(loginctl session-status | head -1 | awk '{print $1}')
# or, if the session ID is already known:
loginctl unlock-session <session-id>
```

## Prevention / Reuse

- Any headed-browser live/e2e run that shows a lower-than-expected pass/coverage count
  (especially frozen-stretch or missing-frame symptoms) should check for a locked session
  before treating it as a code regression — `loginctl unlock-session` first, re-run second.
- Consider disabling the screen lock / idle timeout on any machine or VM dedicated to running
  headed e2e recording tests, to remove this failure mode entirely rather than working around
  it per run.
- If automating this class of e2e run (CI, scheduled job), add a pre-flight check or lock-screen
  disable step rather than relying on an operator to remember this.

## Related

- `test/manual/e2e-test.ts` — the live/e2e tier this affects
