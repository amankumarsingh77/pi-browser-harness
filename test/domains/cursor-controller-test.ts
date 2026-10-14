import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { createVirtualCursorController } from "../../src/cursor/controller";
import type { CursorTarget } from "../../src/cursor/types";
import { cdpError } from "../../src/cdp/errors";
import { err, ok } from "../../src/util/result";
import { createFakeClient } from "./fake-client";

const target: CursorTarget = { targetId: "t1", sessionId: "s1" };

const overlayState = {
  version: 1,
  connected: true,
  visible: true,
  reducedMotion: false,
};

describe("VirtualCursorController", () => {
  test("visual failure degrades the session but still runs the input callback", async () => {
    const fake = await createFakeClient({
      evaluate: () => err(cdpError("remote_error", "injection denied")),
    });
    const cursor = createVirtualCursorController(fake.client, { cursorMutex: fake.cursorMutex });
    let dispatched = false;

    const result = await cursor.runPointerAction(target, undefined, async (visual) => {
      await visual.moveTo({ x: 10, y: 20 });
      dispatched = true;
      return ok("input-result");
    });

    assert.equal(dispatched, true);
    assert.equal(result.success, true);
    assert.equal(result.diagnostics.status, "degraded");
  });

  test("uses zero duration for a target's first move and clamps later moves", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(overlayState) });
    const cursor = createVirtualCursorController(fake.client, {});

    await cursor.runPointerAction(target, undefined, async (visual) => {
      await visual.moveTo({ x: 1, y: 1 });
      await visual.moveTo({ x: 2, y: 2 });
      await visual.moveTo({ x: 5000, y: 5000 });
      return ok(undefined);
    });

    const moveExpressions = fake.evaluated.filter((expression) => expression.includes('"command":"move"'));
    assert.match(moveExpressions[1] ?? "", /"duration":60/);
    assert.match(moveExpressions[2] ?? "", /"duration":180/);
  });

  test("schedules an idle fade 1.2 seconds after a visual action", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(overlayState) });
    const cursor = createVirtualCursorController(fake.client, {});

    await cursor.runPointerAction(target, undefined, async (visual) => {
      await visual.moveTo({ x: 10, y: 20 });
      return ok(undefined);
    });

    await new Promise<void>((resolve) => setTimeout(resolve, 1_250));

    assert.equal(fake.evaluated.filter((expression) => expression.includes('"command":"hide"')).length, 1);
  });

  test("reports remaining idle fade time and restores the deadline after another move", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(overlayState) });
    const cursor = createVirtualCursorController(fake.client, {});
    const originalNow = Date.now;
    let now = 10_000;
    Date.now = () => now;
    try {
      await cursor.runPointerAction(target, undefined, async (visual) => {
        await visual.moveTo({ x: 10, y: 20 });
        return ok(undefined);
      });

      now += 300;
      assert.equal(cursor.status().idleFadeMs, 900);

      await cursor.runPointerAction(target, undefined, async (visual) => {
        await visual.moveTo({ x: 20, y: 30 });
        return ok(undefined);
      });
      assert.equal(cursor.status().idleFadeMs, 1200);
    } finally {
      Date.now = originalNow;
      await cursor.clear();
    }

    const status = cursor.status();
    assert.equal(status.targetId, undefined);
  });

  test("does not retry degraded visual state during its five-second cooldown", async () => {
    const fake = await createFakeClient({
      evaluate: () => err(cdpError("remote_error", "blocked")),
    });
    const cursor = createVirtualCursorController(fake.client, {});

    await cursor.runPointerAction(target, undefined, async (visual) => {
      await visual.moveTo({ x: 10, y: 20 });
      return ok(undefined);
    });
    await cursor.runPointerAction(target, undefined, async (visual) => {
      await visual.moveTo({ x: 20, y: 30 });
      return ok(undefined);
    });

    assert.equal(fake.evaluated.length, 1);
  });

  test("uses zero move duration when the overlay requests reduced motion", async () => {
    const fake = await createFakeClient({
      evaluate: () => ok({ ...overlayState, reducedMotion: true }),
    });
    const cursor = createVirtualCursorController(fake.client, {});

    await cursor.runPointerAction(target, undefined, async (visual) => {
      await visual.moveTo({ x: 1, y: 1 });
      await visual.moveTo({ x: 300, y: 400 });
      return ok(undefined);
    });

    const moveExpressions = fake.evaluated.filter((expression) => expression.includes('"command":"move"'));
    assert.match(moveExpressions[1] ?? "", /"duration":0/);
  });

  test("strict capture rejects disabled, missing-position, show failure, and Top Layer overlap", async () => {
    const disabled = createVirtualCursorController((await createFakeClient()).client, { enabled: false });
    const disabledResult = await disabled.withCaptureVisibility(true, async () => ok("capture"));
    assert.equal(disabledResult.success, false);

    const noPositionFake = await createFakeClient({ evaluate: () => ok(overlayState) });
    const noPosition = createVirtualCursorController(noPositionFake.client, {});
    const noPositionResult = await noPosition.withCaptureVisibility(true, async () => ok("capture"));
    assert.equal(noPositionResult.success, false);

    const showFailedFake = await createFakeClient({
      evaluate: () => err(cdpError("remote_error", "show failed")),
    });
    const showFailed = createVirtualCursorController(showFailedFake.client, {});
    await showFailed.runPointerAction(target, undefined, async (visual) => {
      await visual.moveTo({ x: 10, y: 20 });
      return ok(undefined);
    });
    const showFailedResult = await showFailed.withCaptureVisibility(true, async () => ok("capture"));
    assert.equal(showFailedResult.success, false);

    const overlapFake = await createFakeClient({
      evaluate: () => ok({ ...overlayState, topLayerOverlap: true }),
    });
    const overlap = createVirtualCursorController(overlapFake.client, {});
    await overlap.runPointerAction(target, undefined, async (visual) => {
      await visual.moveTo({ x: 10, y: 20 });
      return ok(undefined);
    });
    const overlapResult = await overlap.withCaptureVisibility(true, async () => ok("capture"));
    assert.equal(overlapResult.success, false);
  });

  test("default suppression preserves capture success and reports degradation", async () => {
    const fake = await createFakeClient({
      evaluate: () => err(cdpError("remote_error", "hide failed")),
    });
    const cursor = createVirtualCursorController(fake.client, {});

    const result = await cursor.withCaptureVisibility(false, async () => ok("capture"));

    assert.equal(result.success, true);
    if (result.success) assert.equal(result.visibility.cursorSuppression, "degraded");
  });

  test("disabling attaches, destroys, and detaches tracked live targets even when ownership is no longer reported", async () => {
    const fake = await createFakeClient({
      ownedTargetIds: ["t1", "t2"],
      listTabs: [
        { targetId: "t1", title: "one", url: "https://one.test", owned: true },
        { targetId: "t2", title: "two", url: "https://two.test", owned: false },
      ],
      canned: {
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s2" }), ok({ sessionId: "cleanup-1" }), ok({ sessionId: "cleanup-2" })],
        "Target.detachFromTarget": [ok({}), ok({})],
      },
      evaluate: () => ok(overlayState),
    });
    const cursor = createVirtualCursorController(fake.client, {});
    await cursor.runPointerAction(target, undefined, async (visual) => {
      await visual.moveTo({ x: 10, y: 20 });
      return ok(undefined);
    });
    await cursor.runPointerAction({ targetId: "t2", sessionId: "s2" }, undefined, async (visual) => {
      await visual.moveTo({ x: 30, y: 40 });
      return ok(undefined);
    });

    await cursor.applySessionSettings(false);

    const detached = fake.callsTo("Target.detachFromTarget");
    assert.equal(detached.length, 2);
    assert.equal(fake.evaluated.filter((expression) => expression.includes('"command":"destroy"')).length, 2);
  });

  test("forget, prune, and clear only remove in-memory cursor state", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(overlayState) });
    const cursor = createVirtualCursorController(fake.client, { cursorMutex: fake.cursorMutex });
    await cursor.runPointerAction(target, undefined, async (visual) => {
      await visual.moveTo({ x: 10, y: 20 });
      return ok(undefined);
    });

    await cursor.forget("t1");
    assert.equal(fake.calls.length, 0);
    await cursor.prune(new Set());
    await cursor.clear();
    assert.equal(fake.calls.length, 0);
  });

  test("clear invalidates an expired idle fade queued behind the cursor mutex", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(overlayState) });
    const cursor = createVirtualCursorController(fake.client, { cursorMutex: fake.cursorMutex });
    await cursor.runPointerAction(target, undefined, async (visual) => {
      await visual.moveTo({ x: 10, y: 20 });
      return ok(undefined);
    });

    const release = await fake.cursorMutex.acquire();
    const clearing = cursor.clear();
    await new Promise<void>((resolve) => setTimeout(resolve, 1_250));
    release();
    await clearing;
    const releaseBarrier = await fake.cursorMutex.acquire();
    releaseBarrier();

    assert.equal(fake.evaluated.filter((expression) => expression.includes('"command":"hide"')).length, 0);
  });

  test("applySessionSettings acquires mutation mutex before the cursor mutex", async () => {
    const fake = await createFakeClient();
    const cursor = createVirtualCursorController(fake.client, { cursorMutex: fake.cursorMutex });

    await cursor.applySessionSettings(false);

    assert.deepEqual(fake.mutexAcquires, ["mutation", "cursor"]);
  });
});
