import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AuthStorage,
  createExtensionRuntime,
  ExtensionRunner,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { dragAndDropTool, dragPoints } from "../../src/domains/drag";
import { scrollTool } from "../../src/domains/scroll";
import type {
  CursorDiagnostics,
  CursorTarget,
  CursorVisualSession,
  VirtualCursorController,
} from "../../src/cursor/types";
import { createVirtualCursorController } from "../../src/cursor/controller";
import { cdpError } from "../../src/cdp/errors";
import { type Result, err, ok } from "../../src/util/result";
import type { ToolErr } from "../../src/util/tool";
import { createFakeClient, type FakeClient } from "./fake-client";

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

type RecordingCursor = VirtualCursorController & {
  readonly order: string[];
};

const createRecordingCursor = (order: string[]): RecordingCursor => {
  const visual: CursorVisualSession = {
    isHealthy: () => true,
    moveTo: async ({ x, y }, immediate = false) => {
      order.push(`visual:${immediate ? "move-now" : "move"}:${x},${y}`);
    },
    moveDrag: async ({ x, y }) => {
      order.push(`visual:drag:${x},${y}`);
    },
    press: async () => {
      order.push("visual:press");
    },
    release: async () => {
      order.push("visual:release");
    },
    showScroll: async (deltaX, deltaY) => {
      order.push(`visual:scroll:${deltaX},${deltaY}`);
    },
  };
  return {
    order,
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
    withCaptureVisibility: async <T,>(
      _includeCursor: boolean,
      capture: (_target: CursorTarget) => Promise<Result<T, ToolErr>>,
    ) => {
      const result = await capture({ targetId: "t1", sessionId: "s1" });
      return result.success
        ? { success: true, data: result.data, visibility: {} }
        : { success: false, error: result.error, visibility: {} };
    },
    applySessionSettings: async () => {},
    status: () => ({ enabled: true, diagnostics: shown }),
    forget: async () => {},
    prune: async () => {},
    clear: async () => {},
  };
};

const drag = (
  fake: FakeClient,
  cursor: VirtualCursorController,
  signal?: AbortSignal,
) => dragAndDropTool.handler(
  { startX: 10, startY: 20, endX: 60, endY: 70 },
  {
    client: fake.client,
    cursor,
    signal,
    onUpdate: () => {},
    extensionCtx: extensionContext(),
  },
);

const scroll = (
  fake: FakeClient,
  cursor: VirtualCursorController,
  args: { readonly x?: number; readonly y?: number; readonly deltaX?: number; readonly deltaY?: number },
) => scrollTool.handler(args, {
  client: fake.client,
  cursor,
  signal: undefined,
  onUpdate: () => {},
  extensionCtx: extensionContext(),
});

const hasType = (params: object | undefined): params is { readonly type: unknown } =>
  params !== undefined && "type" in params;

const callName = (method: string, params: object | undefined): string => {
  const type = hasType(params) ? params.type : undefined;
  if (method === "Input.dispatchMouseEvent" && type === "mouseReleased") {
    return "Input.dispatchMouseEvent:mouseReleased:lastDeliveredPoint";
  }
  if (method === "Input.dispatchDragEvent" && type === "dragCancel") {
    return "Input.dispatchDragEvent:dragCancel";
  }
  return method === "Input.dispatchDragEvent" ? `Input.dispatchDragEvent:${String(type)}` : method;
};

const recordInputOrder = (fake: FakeClient, order: string[]): void => {
  const original = fake.session.call.bind(fake.session);
  fake.session.call = async (method, params, options) => {
    const result = await original(method, params, options);
    order.push(callName(method, params));
    return result;
  };
};

describe("browser_drag_and_drop cursor transaction", () => {
  test("shares hand-checked interpolation points between the visual and drag protocol paths", async () => {
    assert.deepEqual(dragPoints({ x: 10, y: 20 }, { x: 60, y: 70 }), [
      { x: 20, y: 30 },
      { x: 30, y: 40 },
      { x: 40, y: 50 },
      { x: 50, y: 60 },
      { x: 60, y: 70 },
    ]);
  });

  test("releases at the last successfully delivered point after each drag-protocol failure", async (t) => {
    const cases = [
      { name: "dragEnter", dragResults: [err(cdpError("remote_error", "dragEnter failed"))] },
      ...[0, 1, 2, 3, 4].map((failureIndex) => ({
        name: `dragOver ${failureIndex + 1}`,
        dragResults: [
          ok({}),
          ...Array.from({ length: failureIndex }, () => ok({})),
          err(cdpError("remote_error", `dragOver ${failureIndex + 1} failed`)),
        ],
      })),
      {
        name: "drop",
        dragResults: [
          ok({}),
          ok({}),
          ok({}),
          ok({}),
          ok({}),
          ok({}),
          err(cdpError("remote_error", "drop failed")),
        ],
      },
    ];

    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        const order: string[] = [];
        const fake = await createFakeClient({
          canned: { "Input.dispatchDragEvent": scenario.dragResults },
        });
        recordInputOrder(fake, order);

        const result = await drag(fake, createRecordingCursor(order));

        assert.equal(result.success, false);
        assert.deepEqual(order.slice(-3), [
          "Input.cancelDragging",
          "Input.dispatchMouseEvent:mouseReleased:lastDeliveredPoint",
          "visual:release",
        ]);
        const release = fake.callsTo("Input.dispatchMouseEvent").at(-1);
        assert.deepEqual(
          { x: release?.params["x"], y: release?.params["y"] },
          scenario.name === "dragEnter"
            ? { x: 10, y: 20 }
            : scenario.name === "drop"
              ? { x: 60, y: 70 }
              : { x: Number(scenario.name.slice(-1)) * 10, y: 10 + Number(scenario.name.slice(-1)) * 10 },
        );
      });
    }
  });

  test("returns the mouse press failure without attempting drag cleanup", async () => {
    const order: string[] = [];
    const fake = await createFakeClient({
      canned: { "Input.dispatchMouseEvent": [err(cdpError("remote_error", "press failed"))] },
    });

    const result = await drag(fake, createRecordingCursor(order));

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.message, "press failed");
    assert.equal(fake.callsTo("Input.cancelDragging").length, 0);
    assert.equal(fake.callsTo("Input.dispatchDragEvent").length, 0);
    assert.equal(fake.callsTo("Input.dispatchMouseEvent").length, 1);
    assert.deepEqual(order, ["visual:move:10,20", "visual:press", "visual:release"]);
  });

  test("uses dragCancel exactly once only when cancelDragging is unavailable", async () => {
    const fake = await createFakeClient({
      canned: {
        "Input.dispatchDragEvent": [
          err(cdpError("remote_error", "dragEnter failed")),
          ok({}),
        ],
        "Input.cancelDragging": err(cdpError("remote_error", "Method not found")),
      },
    });

    const result = await drag(fake, createRecordingCursor([]));

    assert.equal(result.success, false);
    assert.equal(fake.callsTo("Input.cancelDragging").length, 1);
    assert.deepEqual(
      fake.callsTo("Input.dispatchDragEvent").map((call) => call.params["type"]),
      ["dragEnter", "dragCancel"],
    );
  });

  test("preserves a primary drag error and attaches cancel and release cleanup failures", async () => {
    const fake = await createFakeClient({
      canned: {
        "Input.dispatchDragEvent": [err(cdpError("remote_error", "dragEnter failed"))],
        "Input.cancelDragging": err(cdpError("remote_error", "cancel failed")),
        "Input.dispatchMouseEvent": [
          ok({}),
          err(cdpError("remote_error", "release failed")),
        ],
      },
    });

    const result = await drag(fake, createRecordingCursor([]));

    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.error.message, "dragEnter failed");
      assert.deepEqual(result.error.details?.["cleanupErrors"], [
        { method: "Input.cancelDragging", message: "cancel failed" },
        { method: "Input.dispatchMouseEvent", message: "release failed" },
      ]);
    }
  });

  test("returns cleanup failures when the main drag path succeeded", async () => {
    const fake = await createFakeClient({
      canned: {
        "Input.dispatchMouseEvent": [
          ok({}),
          err(cdpError("remote_error", "release failed")),
        ],
      },
    });

    const result = await drag(fake, createRecordingCursor([]));

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.message, "release failed");
  });

  test("cancels after every successful intermediate protocol delivery without dropping", async (t) => {
    const points = [
      { name: "mousePressed", eventType: "mousePressed" },
      { name: "dragEnter", eventType: "dragEnter" },
      { name: "dragOver 1", eventType: "dragOver" },
      { name: "dragOver 2", eventType: "dragOver" },
      { name: "dragOver 3", eventType: "dragOver" },
      { name: "dragOver 4", eventType: "dragOver" },
      { name: "dragOver 5", eventType: "dragOver" },
    ] as const;

    for (const point of points) {
      await t.test(point.name, async () => {
        const controller = new AbortController();
        const fake = await createFakeClient();
        let dragOverCount = 0;
        const original = fake.session.call.bind(fake.session);
        fake.session.call = async (method, params, options) => {
          const result = await original(method, params, options);
          if (method === "Input.dispatchMouseEvent" && hasType(params) && params.type === "mousePressed" && point.eventType === "mousePressed") {
            controller.abort();
          }
          if (method === "Input.dispatchDragEvent" && hasType(params) && params.type === point.eventType) {
            if (point.eventType !== "dragOver") controller.abort();
            else {
              dragOverCount += 1;
              if (dragOverCount === Number(point.name.slice(-1))) controller.abort();
            }
          }
          return result;
        };

        const result = await drag(fake, createRecordingCursor([]), controller.signal);

        assert.equal(result.success, false);
        assert.equal(fake.callsTo("Input.dispatchDragEvent").some((call) => call.params["type"] === "drop"), false);
        assert.equal(fake.callsTo("Input.cancelDragging").length, point.name === "mousePressed" ? 0 : 1);
        assert.equal(
          fake.callsTo("Input.dispatchMouseEvent").filter((call) => call.params["type"] === "mouseReleased").length,
          1,
        );
      });
    }
  });

  test("returns a failed cancelDragging cleanup operation when no primary error exists", async () => {
    const controller = new AbortController();
    const fake = await createFakeClient({
      canned: { "Input.cancelDragging": err(cdpError("remote_error", "cancel failed")) },
    });
    const original = fake.session.call.bind(fake.session);
    fake.session.call = async (method, params, options) => {
      const result = await original(method, params, options);
      if (method === "Input.dispatchDragEvent" && hasType(params) && params.type === "dragEnter") controller.abort();
      return result;
    };

    const result = await drag(fake, createRecordingCursor([]), controller.signal);

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.message, "Drag cancelled");
  });

  test("stops visual interpolation waits after a real controller degrades while delivering every dragOver", async (t) => {
    let moveCommands = 0;
    const fake = await createFakeClient({
      evaluate: (expression) => {
        if (expression.includes('"command":"move"') && ++moveCommands === 2) {
          return err(cdpError("remote_error", "overlay unavailable"));
        }
        return ok({ version: 1, connected: true, visible: true, reducedMotion: false });
      },
    });
    const cursor = createVirtualCursorController(fake.client, { cursorMutex: fake.cursorMutex });
    let interpolationWaits = 0;
    t.mock.method(globalThis, "setTimeout", (
      callback: TimerHandler,
      delay?: number,
      ...args: unknown[]
    ): ReturnType<typeof setTimeout> => {
      if (delay === 16) interpolationWaits += 1;
      const handle = setInterval(() => {}, 1);
      clearInterval(handle);
      queueMicrotask(() => {
        if (typeof callback === "function") callback(...args);
      });
      return handle;
    });

    try {
      const result = await drag(fake, cursor);

      assert.equal(result.success, true);
      assert.equal(interpolationWaits, 0);
      assert.equal(
        fake.callsTo("Input.dispatchDragEvent").filter((call) => call.params["type"] === "dragOver").length,
        5,
      );
    } finally {
      await cursor.clear();
    }
  });
});

describe("browser_scroll cursor orchestration", () => {
  test("moves to the explicit scroll position after bringToFront and reports visual direction after wheel", async () => {
    const order: string[] = [];
    const fake = await createFakeClient();
    fake.client.pageInfo = () => Promise.resolve(ok({
      url: "https://example.test/",
      title: "Fake",
      width: 100,
      height: 80,
      scrollX: 0,
      scrollY: 0,
      pageWidth: 100,
      pageHeight: 800,
    }));
    recordInputOrder(fake, order);

    const result = await scroll(fake, createRecordingCursor(order), { x: 12, y: 34, deltaX: -4, deltaY: 50 });

    assert.equal(result.success, true);
    assert.deepEqual(order, [
      "Page.bringToFront",
      "visual:move:12,34",
      "Input.dispatchMouseEvent",
      "Input.dispatchMouseEvent",
      "visual:scroll:-4,50",
    ]);
    if (result.success) {
      assert.deepEqual(result.data.details, {
        x: 12,
        y: 34,
        deltaX: -4,
        deltaY: 50,
        cursorVisual: "shown",
      });
    }
  });

  test("moves to the viewport center when scroll coordinates are omitted", async () => {
    const order: string[] = [];
    const fake = await createFakeClient();
    fake.client.pageInfo = () => Promise.resolve(ok({
      url: "https://example.test/",
      title: "Fake",
      width: 101,
      height: 79,
      scrollX: 0,
      scrollY: 0,
      pageWidth: 101,
      pageHeight: 800,
    }));

    const result = await scroll(fake, createRecordingCursor(order), {});

    assert.equal(result.success, true);
    assert.ok(order.includes("visual:move:51,40"));
  });

  test("keeps existing wheel CDP parameters when the visual session is degraded", async () => {
    const fake = await createFakeClient();
    fake.client.pageInfo = () => Promise.resolve(ok({
      url: "https://example.test/",
      title: "Fake",
      width: 100,
      height: 80,
      scrollX: 0,
      scrollY: 0,
      pageWidth: 100,
      pageHeight: 800,
    }));
    const cursor = createRecordingCursor([]);
    cursor.runPointerAction = async <T>(
      _target: CursorTarget,
      _signal: AbortSignal | undefined,
      callback: (visual: CursorVisualSession) => Promise<Result<T, ToolErr>>,
    ) => {
      const result = await (async () => callback({
        isHealthy: () => false,
        moveTo: async () => {
          throw new Error("overlay unavailable");
        },
        moveDrag: async () => {},
        press: async () => {},
        release: async () => {},
        showScroll: async () => {
          throw new Error("overlay unavailable");
        },
      }))();
      return result.success
        ? { success: true, data: result.data, diagnostics: { status: "degraded", reason: "overlay unavailable" } }
        : { success: false, error: result.error, diagnostics: { status: "degraded", reason: "overlay unavailable" } };
    };

    const result = await scroll(fake, cursor, { x: 12, y: 34, deltaX: -4, deltaY: 50 });

    assert.equal(result.success, true);
    assert.deepEqual(fake.callsTo("Input.dispatchMouseEvent").map((call) => call.params), [
      { type: "mouseMoved", x: 12, y: 34, button: "none", buttons: 0 },
      {
        type: "mouseWheel",
        x: 12,
        y: 34,
        deltaX: -4,
        deltaY: 50,
        button: "none",
        buttons: 0,
        pointerType: "mouse",
      },
    ]);
    if (result.success) {
      assert.equal(result.data.details?.["cursorVisual"], "degraded");
      assert.equal(result.data.details?.["cursorReason"], "overlay unavailable");
    }
  });
});
