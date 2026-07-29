import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { startScreencastOn, stopScreencastOn } from "../../src/cdp/screencast";
import { createStubTransport, createFakeClient } from "../domains/fake-client";
import { createCdpSession } from "../../src/cdp/session";
import { ok, err } from "../../src/util/result";
import { cdpError } from "../../src/cdp/errors";
import type { InputKind, RecordingSink, RecordingSummary, StopReason } from "../../src/cdp/types";
import type { Result } from "../../src/util/result";
import type { RecordingFinalizeError } from "../../src/cdp/types";

const flush = async (): Promise<void> => {
  await tick();
  await tick();
};

const fakeSink = (): RecordingSink & { readonly frames: string[]; readonly inputs: Array<{ x: number; y: number; kind: InputKind }> } => {
  const frames: string[] = [];
  const inputs: Array<{ x: number; y: number; kind: InputKind }> = [];
  return {
    outputPath: "/tmp/recording.mp4",
    parked: false,
    frames,
    inputs,
    onFrame(data) {
      frames.push(data);
    },
    noteInput(x, y, kind) {
      inputs.push({ x, y, kind });
    },
    noteConsumerRestart() {},
    async finalize(_reason: StopReason): Promise<Result<RecordingSummary, RecordingFinalizeError>> {
      return ok({
        path: "/tmp/recording.mp4",
        durationSec: 1,
        bytes: 100,
        truncated: false,
        frozenSec: 0,
        framesReceived: frames.length,
      });
    },
  };
};

describe("startScreencastOn / stopScreencastOn", () => {
  test("startScreencastOn issues Page.startScreencast on the given session", async () => {
    const stub = createStubTransport({ "Page.startScreencast": ok({}) });
    const session = createCdpSession(stub.transport);
    const r = await startScreencastOn(session, "s1");
    assert.equal(r.success, true);
    const call = stub.calls.find((c) => c.method === "Page.startScreencast");
    assert.ok(call);
    assert.equal(call?.sessionId, "s1");
    assert.equal(call?.params["format"], "jpeg");
  });

  test("startScreencastOn propagates a failure", async () => {
    const stub = createStubTransport({
      "Page.startScreencast": err(cdpError("session_not_found", "gone")),
    });
    const session = createCdpSession(stub.transport);
    const r = await startScreencastOn(session, "s1");
    assert.equal(r.success, false);
  });

  test("stopScreencastOn returns ok even when the underlying call fails — a closed tab is not an actionable error", async () => {
    const stub = createStubTransport({
      "Page.stopScreencast": err(cdpError("session_not_found", "gone")),
    });
    const session = createCdpSession(stub.transport);
    const r = await stopScreencastOn(session, "s1");
    assert.equal(r.success, true);
  });
});

describe("CdpSession recording slot", () => {
  test("startRecording fails when no tab is attached", async () => {
    const stub = createStubTransport();
    const session = createCdpSession(stub.transport);
    const r = await session.startRecording(fakeSink());
    assert.equal(r.success, false);
    assert.equal(session.activeRecording(), null);
  });

  test("startRecording attaches the sink and starts the screencast on the current tab", async () => {
    const fake = await createFakeClient({ canned: { "Page.startScreencast": ok({}) } });
    const sink = fakeSink();
    const r = await fake.session.startRecording(sink);
    assert.equal(r.success, true);
    assert.equal(fake.session.activeRecording(), sink);
    const call = fake.callsTo("Page.startScreencast")[0];
    assert.equal(call?.sessionId, "s1");
  });

  test("stopRecording clears the slot and returns the sink synchronously", async () => {
    const fake = await createFakeClient({
      canned: { "Page.startScreencast": ok({}), "Page.stopScreencast": ok({}) },
    });
    const sink = fakeSink();
    await fake.session.startRecording(sink);
    const returned = fake.session.stopRecording();
    assert.equal(returned, sink);
    assert.equal(fake.session.activeRecording(), null);
  });

  test("noteInput forwards to the active recording and is a no-op otherwise", async () => {
    const fake = await createFakeClient({ canned: { "Page.startScreencast": ok({}) } });
    const sink = fakeSink();
    fake.session.noteInput(1, 2, "click");
    assert.deepEqual(sink.inputs, []);
    await fake.session.startRecording(sink);
    fake.session.noteInput(10, 20, "click");
    assert.deepEqual(sink.inputs, [{ x: 10, y: 20, kind: "click" }]);
  });

  test("S19: a screencast frame is acknowledged before the sink finishes handling it", async () => {
    const fake = await createFakeClient({ canned: { "Page.startScreencast": ok({}) } });
    const order: string[] = [];
    const transport = fake.client.transport();
    const originalRequest = transport.request;
    transport.request = (method, params, opts) => {
      if (method === "Page.screencastFrameAck") order.push("ack");
      return originalRequest(method, params, opts);
    };

    const sink: RecordingSink = {
      outputPath: "/tmp/r.mp4",
      parked: false,
      onFrame() {
        // Simulates slow sink processing: still recorded, but after "ack" is already in the order.
        order.push("frame-handled");
      },
      noteInput() {},
      noteConsumerRestart() {},
      async finalize() {
        return ok({ path: "/tmp/r.mp4", durationSec: 1, bytes: 1, truncated: false, frozenSec: 0, framesReceived: 0 });
      },
    };
    const started = await fake.session.startRecording(sink);
    assert.equal(started.success, true);

    fake.emit({
      method: "Page.screencastFrame",
      sessionId: "s1",
      params: { data: "AAA", sessionId: 7, metadata: {} },
    });
    await flush();

    assert.deepEqual(order, ["ack", "frame-handled"]);
    const ackCall = fake.callsTo("Page.screencastFrameAck")[0];
    assert.equal(ackCall?.params["sessionId"], 7);
  });
});
