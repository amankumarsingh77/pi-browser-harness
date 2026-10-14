import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthStorage,
  createExtensionRuntime,
  ExtensionRunner,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { ScreenshotArgs, screenshotTool } from "../../src/domains/screenshot";
import { SnapshotArgs, snapshotTool } from "../../src/domains/snapshot";
import { PrintPdfArgs, printToPdfTool } from "../../src/domains/files";
import { createVirtualCursorController } from "../../src/cursor/controller";
import type {
  CursorDiagnostics,
  CursorTarget,
  CursorVisualSession,
  VirtualCursorController,
} from "../../src/cursor/types";
import type { Result } from "../../src/util/result";
import { ok } from "../../src/util/result";
import type { ToolErr } from "../../src/util/tool";
import { cdpError } from "../../src/cdp/errors";
import { createFakeClient } from "./fake-client";

const extensionContext = (): ReturnType<ExtensionRunner["createContext"]> => {
  const runner = new ExtensionRunner(
    [],
    createExtensionRuntime(),
    process.cwd(),
    SessionManager.inMemory(process.cwd()),
    ModelRegistry.inMemory(AuthStorage.inMemory()),
  );
  return runner.createContext();
};

const shown: CursorDiagnostics = { status: "shown" };
const overlayState = {
  version: 1,
  connected: true,
  visible: true,
  reducedMotion: false,
};

type RecordingCursor = VirtualCursorController & {
  readonly includeCalls: boolean[];
};

const createRecordingCursor = (
  visibility: { readonly cursorSuppression?: "ok" | "degraded"; readonly cursorReason?: string } = {},
): RecordingCursor => {
  const includeCalls: boolean[] = [];
  const visual: CursorVisualSession = {
    isHealthy: () => true,
    moveTo: async () => {},
    moveDrag: async () => {},
    press: async () => {},
    release: async () => {},
    showScroll: async () => {},
  };
  return {
    includeCalls,
    runPointerAction: async <T>(
      _target: CursorTarget,
      _signal: AbortSignal | undefined,
      callback: (session: CursorVisualSession) => Promise<Result<T, ToolErr>>,
    ) => {
      const result = await callback(visual);
      return result.success
        ? { success: true, data: result.data, diagnostics: shown }
        : { success: false, error: result.error, diagnostics: shown };
    },
    withCaptureVisibility: async <T>(
      includeCursor: boolean,
      capture: (target: CursorTarget) => Promise<Result<T, ToolErr>>,
    ) => {
      includeCalls.push(includeCursor);
      const result = await capture({ targetId: "t1", sessionId: "s1" });
      return result.success
        ? { success: true, data: result.data, visibility }
        : { success: false, error: result.error, visibility };
    },
    applySessionSettings: async () => {},
    status: () => ({ enabled: true, diagnostics: shown }),
    forget: async () => {},
    prune: async () => {},
    clear: async () => {},
  };
};

const toolContext = (
  client: Awaited<ReturnType<typeof createFakeClient>>["client"],
  cursor: VirtualCursorController,
) => ({
  client,
  cursor,
  signal: undefined,
  onUpdate: () => {},
  extensionCtx: extensionContext(),
});

describe("capture cursor orchestration", () => {
  test("publishes includeCursor only for screenshot and snapshot schemas", () => {
    assert.ok(ScreenshotArgs.properties.includeCursor);
    assert.ok(SnapshotArgs.properties.includeCursor);
    assert.equal("includeCursor" in PrintPdfArgs.properties, false);
  });

  test("parallel screenshot takes mutation before capture visibility", async () => {
    const fake = await createFakeClient({
      canned: { "Page.captureScreenshot": ok({ data: "" }) },
      evaluate: () => ok(overlayState),
    });
    const cursor = createVirtualCursorController(fake.client, { cursorMutex: fake.cursorMutex });

    const registered = screenshotTool;
    const result = await registered.handler({}, toolContext(fake.client, cursor));

    assert.equal(result.success, true);
    assert.deepEqual(fake.mutexAcquires, ["mutation", "cursor"]);
  });

  test("text-only snapshot remains outside the mutation lane", async () => {
    const fake = await createFakeClient({
      canned: { "Accessibility.getFullAXTree": ok({ nodes: [] }) },
    });
    fake.client.pageInfo = () => Promise.resolve(ok({
      url: "https://example.test/",
      title: "Example",
      width: 800,
      height: 600,
      scrollX: 0,
      scrollY: 0,
      pageWidth: 800,
      pageHeight: 600,
    }));

    const result = await snapshotTool.handler({ includeScreenshot: false }, toolContext(fake.client, createRecordingCursor()));

    assert.equal(result.success, true);
    assert.deepEqual(fake.mutexAcquires, []);
  });

  test("text-only snapshot rejects cursor inclusion before locks or capture calls", async () => {
    const fake = await createFakeClient();
    const cursor = createRecordingCursor();

    const result = await snapshotTool.handler(
      { includeScreenshot: false, includeCursor: true },
      toolContext(fake.client, cursor),
    );

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.kind, "invalid_state");
    assert.deepEqual(fake.mutexAcquires, []);
    assert.deepEqual(cursor.includeCalls, []);
    assert.deepEqual(fake.calls, []);
    assert.deepEqual(fake.evaluated, []);
  });

  test("snapshot image keeps AX and screenshot calls on the pinned target session", async () => {
    const fake = await createFakeClient({
      canned: {
        "Accessibility.getFullAXTree": ok({ nodes: [] }),
        "Page.captureScreenshot": ok({ data: "" }),
      },
      evaluate: (expression) => expression.includes("location.href")
        ? ok({ url: "https://example.test/", title: "Example" })
        : ok(overlayState),
    });
    fake.client.pageInfo = () => Promise.resolve(ok({
      url: "https://example.test/",
      title: "Example",
      width: 800,
      height: 600,
      scrollX: 0,
      scrollY: 0,
      pageWidth: 800,
      pageHeight: 600,
    }));
    const cursor = createVirtualCursorController(fake.client, { cursorMutex: fake.cursorMutex });

    const result = await snapshotTool.handler(
      { includeScreenshot: true },
      toolContext(fake.client, cursor),
    );

    assert.equal(result.success, true);
    assert.equal(fake.callsTo("Accessibility.getFullAXTree")[0]?.sessionId, "s1");
    assert.equal(fake.callsTo("Page.captureScreenshot")[0]?.sessionId, "s1");
    assert.deepEqual(fake.mutexAcquires, ["mutation", "cursor"]);
  });

  test("PDF relies on its serialized lane and asks the controller to hide", async () => {
    const fake = await createFakeClient({
      canned: { "Page.printToPDF": ok({ data: "" }) },
    });
    const cursor = createRecordingCursor();

    const result = await printToPdfTool.handler({}, toolContext(fake.client, cursor));

    assert.equal(result.success, true);
    assert.deepEqual(cursor.includeCalls, [false]);
    assert.deepEqual(fake.mutexAcquires, []);
  });

  test("default hide failure preserves screenshot and returns suppression diagnostics", async () => {
    const fake = await createFakeClient({
      canned: { "Page.captureScreenshot": ok({ data: "" }) },
    });
    const cursor = createRecordingCursor({
      cursorSuppression: "degraded",
      cursorReason: "hide failed",
    });

    const result = await screenshotTool.handler({}, toolContext(fake.client, cursor));

    assert.equal(result.success, true);
    if (result.success) {
      assert.equal(result.data.details?.["cursorSuppression"], "degraded");
      assert.equal(result.data.details?.["cursorReason"], "hide failed");
    }
  });

  test("strict inclusion does not capture after the controller rejects visibility", async () => {
    const fake = await createFakeClient({
      canned: { "Page.captureScreenshot": ok({ data: "" }) },
    });
    const cursor = createVirtualCursorController(fake.client, { enabled: false, cursorMutex: fake.cursorMutex });

    const result = await screenshotTool.handler({ includeCursor: true }, toolContext(fake.client, cursor));

    assert.equal(result.success, false);
    assert.equal(fake.callsTo("Page.captureScreenshot").length, 0);
  });

  test("strict inclusion restores an idle cursor fade after capture", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(overlayState) });
    const cursor = createVirtualCursorController(fake.client, { cursorMutex: fake.cursorMutex });
    const current = fake.client.current();
    assert.ok(current);
    await cursor.runPointerAction(current, undefined, async (visual) => {
      await visual.moveTo({ x: 10, y: 20 });
      return ok(undefined);
    });
    const before = cursor.status().idleFadeMs;
    assert.ok(before !== undefined);

    const result = await cursor.withCaptureVisibility(true, async () => ok("captured"));

    assert.equal(result.success, true);
    assert.ok(cursor.status().idleFadeMs !== undefined);
    assert.equal(fake.evaluated.filter((expression) => expression.includes('"command":"show"')).length, 1);
    await cursor.clear();
  });

  test("target detachment keeps the capture CDP error", async () => {
    const fake = await createFakeClient({
      canned: {
        "Page.captureScreenshot": { success: false, error: cdpError("session_not_found", "target detached") },
      },
      evaluate: () => ok(overlayState),
    });
    const cursor = createVirtualCursorController(fake.client, { cursorMutex: fake.cursorMutex });

    const result = await screenshotTool.handler({}, toolContext(fake.client, cursor));

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.message, "target detached");
  });
});
