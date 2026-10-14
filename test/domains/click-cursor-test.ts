import { test, describe } from "node:test";
import assert from "node:assert/strict";
import {
  AuthStorage,
  createExtensionRuntime,
  ExtensionRunner,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import { clickTool } from "../../src/domains/click";
import type { BrowserClient } from "../../src/client";
import type {
  CursorDiagnostics,
  CursorTarget,
  CursorVisualSession,
  VirtualCursorController,
} from "../../src/cursor/types";
import type { Result } from "../../src/util/result";
import type { ToolErr } from "../../src/util/tool";
import { cdpError } from "../../src/cdp/errors";
import { err } from "../../src/util/result";
import { setDebugClicks } from "../../src/util/debug";
import { createFakeClient, type Canned } from "./fake-client";

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

type ClickArgs = {
  readonly ref?: string;
  readonly x?: number;
  readonly y?: number;
  readonly button?: "left" | "right" | "middle";
  readonly count?: number;
};

type RecordingCursor = VirtualCursorController & {
  readonly order: string[];
};

const shown: CursorDiagnostics = { status: "shown" };

const createRecordingCursor = (
  order: string[],
  options: {
    readonly diagnostics?: CursorDiagnostics;
    readonly afterMove?: (moveCount: number) => void;
    readonly afterPress?: () => void;
    readonly failMove?: boolean;
    readonly failCorrectiveMove?: boolean;
    readonly failPress?: boolean;
    readonly failRelease?: boolean;
  } = {},
): RecordingCursor => {
  let moveCount = 0;
  const visual: CursorVisualSession = {
    isHealthy: () => true,
    moveTo: async ({ x, y }, immediate = false) => {
      moveCount += 1;
      order.push(`visual:${immediate ? "move-now" : "move"}:${x},${y}`);
      options.afterMove?.(moveCount);
      if (options.failMove || (options.failCorrectiveMove && moveCount === 2)) {
        throw new Error("overlay unavailable");
      }
    },
    moveDrag: async () => {},
    press: async (button) => {
      order.push(`visual:press:${button}`);
      options.afterPress?.();
      if (options.failPress) throw new Error("overlay press unavailable");
    },
    release: async (button, count) => {
      order.push(`visual:release:${button}:${count}`);
      if (options.failRelease) throw new Error("overlay release unavailable");
    },
    showScroll: async () => {},
  };

  return {
    order,
    runPointerAction: async <T>(
      _target: CursorTarget,
      _signal: AbortSignal | undefined,
      callback: (session: CursorVisualSession) => Promise<Result<T, ToolErr>>,
    ) => {
      const result = await callback(visual);
      const diagnostics = options.diagnostics ?? shown;
      return result.success
        ? { success: true, data: result.data, diagnostics }
        : { success: false, error: result.error, diagnostics };
    },
    withCaptureVisibility: async <T,>(
      _includeCursor: boolean,
      capture: () => Promise<Result<T, ToolErr>>,
    ) => {
      const result = await capture();
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

const box = (x: number, y: number): { readonly success: true; readonly data: { readonly model: unknown } } => ({
  success: true,
  data: {
    model: {
      content: [x, y, x + 40, y, x + 40, y + 60, x, y + 60],
      width: 40,
      height: 60,
    },
  },
});

const click = async (
  client: BrowserClient,
  cursor: VirtualCursorController,
  args: ClickArgs,
  signal?: AbortSignal,
) => clickTool.handler(args, {
  client,
  cursor,
  signal,
  onUpdate: () => {},
  extensionCtx: extensionContext(),
});

describe("browser_click cursor orchestration", () => {
  test("revalidates the fixed backend node after visual movement before dispatching CDP input", async () => {
    const order: string[] = [];
    let boxCalls = 0;
    const canned: Canned = {
      "DOM.getBoxModel": [
        box(100, 200),
        box(200, 290),
      ],
    };
    const fake = await createFakeClient({ canned, refs: [{ ref: "e1", backendId: 42 }] });
    const originalCall = fake.session.call.bind(fake.session);
    fake.session.call = async (method, params, opts) => {
      if (method === "DOM.getBoxModel") {
        boxCalls += 1;
        if (boxCalls > 1 && params !== undefined && "backendNodeId" in params) {
          order.push(`box:backend:${String(params["backendNodeId"])}`);
        }
      }
      if (method === "Input.dispatchMouseEvent" && params !== undefined
        && "type" in params && "x" in params && "y" in params) {
        order.push(`cdp:${String(params["type"])}:${String(params["x"])},${String(params["y"])}`);
      }
      return originalCall(method, params, opts);
    };
    const cursor = createRecordingCursor(order);

    const result = await click(fake.client, cursor, { ref: "e1" });

    assert.equal(result.success, true);
    assert.deepEqual(order, [
      "visual:move:120,230",
      "box:backend:42",
      "visual:move-now:220,320",
      "cdp:mouseMoved:220,320",
      "visual:press:left",
      "cdp:mousePressed:220,320",
      "cdp:mouseReleased:220,320",
      "visual:release:left:1",
    ]);
    if (result.success) assert.deepEqual(result.data.details, { x: 220, y: 320, ref: "e1", cursorVisual: "shown" });
  });

  test("literal coordinates skip backend-node revalidation", async () => {
    const order: string[] = [];
    const fake = await createFakeClient();
    const cursor = createRecordingCursor(order);

    const result = await click(fake.client, cursor, { x: 12, y: 34 });

    assert.equal(result.success, true);
    assert.equal(fake.callsTo("DOM.getBoxModel").length, 0);
    assert.deepEqual(
      fake.callsTo("Input.dispatchMouseEvent").map((call) => call.params["type"]),
      ["mouseMoved", "mousePressed", "mouseReleased"],
    );
  });

  test("keeps the originally resolved backend node when the ref map changes during animation", async () => {
    const fake = await createFakeClient({
      canned: { "DOM.getBoxModel": [box(100, 200), box(200, 290)] },
      refs: [{ ref: "e1", backendId: 42 }],
    });
    const cursor = createRecordingCursor([], {
      afterMove: () => fake.session.setRefMap(new Map([["e1", 99]]), new Map([["e1", "button|New||"]])),
    });

    const result = await click(fake.client, cursor, { ref: "e1" });

    assert.equal(result.success, true);
    assert.deepEqual(
      fake.callsTo("DOM.getBoxModel").map((call) => call.params["backendNodeId"]),
      [42, 42],
    );
  });

  test("does not send mouse input when the captured node disappears during animation", async () => {
    const fake = await createFakeClient({
      canned: {
        "DOM.getBoxModel": [
          box(100, 200),
          err(cdpError("invalid_response", "No node found")),
        ],
      },
      refs: [{ ref: "e1", backendId: 42 }],
    });

    const result = await click(fake.client, createRecordingCursor([]), { ref: "e1" });

    assert.equal(result.success, false);
    if (!result.success) assert.equal(result.error.kind, "invalid_state");
    assert.equal(fake.callsTo("Input.dispatchMouseEvent").length, 0);
  });

  test("stops before visual movement and before revalidation when cancelled", async () => {
    const beforeMove = new AbortController();
    beforeMove.abort();
    const first = await createFakeClient({ refs: [{ ref: "e1", backendId: 42 }] });
    const firstResult = await click(first.client, createRecordingCursor([]), { ref: "e1" }, beforeMove.signal);
    assert.equal(firstResult.success, false);
    assert.equal(first.callsTo("Input.dispatchMouseEvent").length, 0);

    const beforeRefresh = new AbortController();
    const second = await createFakeClient({
      canned: { "DOM.getBoxModel": [box(100, 200), box(200, 290)] },
      refs: [{ ref: "e1", backendId: 42 }],
    });
    const secondResult = await click(
      second.client,
      createRecordingCursor([], { afterMove: () => beforeRefresh.abort() }),
      { ref: "e1" },
      beforeRefresh.signal,
    );
    assert.equal(secondResult.success, false);
    assert.equal(second.callsTo("DOM.getBoxModel").length, 1);
    assert.equal(second.callsTo("Input.dispatchMouseEvent").length, 0);
  });

  test("stops after mouse movement before pressing when cancelled", async () => {
    const controller = new AbortController();
    const fake = await createFakeClient();
    const originalCall = fake.session.call.bind(fake.session);
    fake.session.call = async (method, params, opts) => {
      const result = await originalCall(method, params, opts);
      if (method === "Input.dispatchMouseEvent" && params !== undefined
        && "type" in params && params["type"] === "mouseMoved") {
        controller.abort();
      }
      return result;
    };

    const result = await click(fake.client, createRecordingCursor([]), { x: 12, y: 34 }, controller.signal);

    assert.equal(result.success, false);
    assert.deepEqual(
      fake.callsTo("Input.dispatchMouseEvent").map((call) => call.params["type"]),
      ["mouseMoved"],
    );
  });

  test("stops before CDP movement when cancelled during the corrective visual snap", async () => {
    const controller = new AbortController();
    const fake = await createFakeClient({
      canned: { "DOM.getBoxModel": [box(100, 200), box(200, 290)] },
      refs: [{ ref: "e1", backendId: 42 }],
    });
    const cursor = createRecordingCursor([], {
      failCorrectiveMove: true,
      afterMove: (moveCount) => {
        if (moveCount === 2) controller.abort();
      },
    });

    const result = await click(fake.client, cursor, { ref: "e1" }, controller.signal);

    assert.equal(result.success, false);
    assert.equal(fake.callsTo("Input.dispatchMouseEvent").length, 0);
  });

  test("releases after a cancellation following a successful press", async () => {
    const controller = new AbortController();
    const fake = await createFakeClient();
    const originalCall = fake.session.call.bind(fake.session);
    fake.session.call = async (method, params, opts) => {
      const result = await originalCall(method, params, opts);
      if (method === "Input.dispatchMouseEvent" && params !== undefined
        && "type" in params && params["type"] === "mousePressed") {
        controller.abort();
      }
      return result;
    };
    const order: string[] = [];

    const result = await click(fake.client, createRecordingCursor(order), { x: 12, y: 34 }, controller.signal);

    assert.equal(result.success, false);
    assert.deepEqual(
      fake.callsTo("Input.dispatchMouseEvent").map((call) => call.params["type"]),
      ["mouseMoved", "mousePressed", "mouseReleased"],
    );
    assert.deepEqual(order, ["visual:move:12,34", "visual:press:left", "visual:release:left:1"]);
  });

  test("keeps CDP input active and reports a degraded visual session", async () => {
    const fake = await createFakeClient();
    const result = await click(
      fake.client,
      createRecordingCursor([], { diagnostics: { status: "degraded", reason: "overlay unavailable" } }),
      { x: 12, y: 34 },
    );

    assert.equal(result.success, true);
    assert.deepEqual(
      fake.callsTo("Input.dispatchMouseEvent").map((call) => call.params["type"]),
      ["mouseMoved", "mousePressed", "mouseReleased"],
    );
    if (result.success) {
      assert.equal(result.data.details?.["cursorVisual"], "degraded");
      assert.equal(result.data.details?.["cursorReason"], "overlay unavailable");
    }
  });

  test("rejected visual operations never block the CDP click sequence", async (t) => {
    const cases = [
      {
        name: "initial move",
        options: { failMove: true },
        client: async () => createFakeClient(),
        args: { x: 12, y: 34 } satisfies ClickArgs,
      },
      {
        name: "corrective move",
        options: { failCorrectiveMove: true },
        client: async () => createFakeClient({
          canned: { "DOM.getBoxModel": [box(100, 200), box(200, 290)] },
          refs: [{ ref: "e1", backendId: 42 }],
        }),
        args: { ref: "e1" } satisfies ClickArgs,
      },
      {
        name: "press",
        options: { failPress: true },
        client: async () => createFakeClient(),
        args: { x: 12, y: 34 } satisfies ClickArgs,
      },
      {
        name: "release",
        options: { failRelease: true },
        client: async () => createFakeClient(),
        args: { x: 12, y: 34 } satisfies ClickArgs,
      },
    ] as const;

    for (const scenario of cases) {
      await t.test(scenario.name, async () => {
        const fake = await scenario.client();
        const result = await click(
          fake.client,
          createRecordingCursor([], scenario.options),
          scenario.args,
        );

        assert.equal(result.success, true);
        assert.deepEqual(
          fake.callsTo("Input.dispatchMouseEvent").map((call) => call.params["type"]),
          ["mouseMoved", "mousePressed", "mouseReleased"],
        );
      });
    }
  });

  test("a visual release rejection does not replace the CDP release error", async () => {
    const fake = await createFakeClient({
      canned: {
        "Input.dispatchMouseEvent": [
          { success: true, data: {} },
          { success: true, data: {} },
          err(cdpError("remote_error", "CDP release failed")),
        ],
      },
    });

    const result = await click(
      fake.client,
      createRecordingCursor([], { failRelease: true }),
      { x: 12, y: 34 },
    );

    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.error.kind, "cdp_error");
      assert.equal(result.error.message, "CDP release failed");
    }
  });

  test("a visual press rejection does not replace the CDP press error", async () => {
    const fake = await createFakeClient({
      canned: {
        "Input.dispatchMouseEvent": [
          { success: true, data: {} },
          err(cdpError("remote_error", "CDP press failed")),
        ],
      },
    });

    const result = await click(
      fake.client,
      createRecordingCursor([], { failPress: true, failRelease: true }),
      { x: 12, y: 34 },
    );

    assert.equal(result.success, false);
    if (!result.success) {
      assert.equal(result.error.kind, "cdp_error");
      assert.equal(result.error.message, "CDP press failed");
    }
    assert.deepEqual(
      fake.callsTo("Input.dispatchMouseEvent").map((call) => call.params["type"]),
      ["mouseMoved", "mousePressed"],
    );
  });

  test("captures debug output after the pointer action with corrected coordinates", async () => {
    const order: string[] = [];
    const fake = await createFakeClient({
      canned: {
        "DOM.getBoxModel": [box(100, 200), box(200, 290)],
        "Page.captureScreenshot": { success: true, data: { data: "" } },
      },
      refs: [{ ref: "e1", backendId: 42 }],
    });
    const cursor = createRecordingCursor(order);
    const runPointerAction = cursor.runPointerAction.bind(cursor);
    cursor.runPointerAction = async (target, signal, callback) => {
      const result = await runPointerAction(target, signal, callback);
      order.push("cursor:released");
      return result;
    };
    const withCaptureVisibility = cursor.withCaptureVisibility.bind(cursor);
    cursor.withCaptureVisibility = async (includeCursor, capture) => {
      order.push(`capture:suppressed:${String(includeCursor)}`);
      return withCaptureVisibility(includeCursor, capture);
    };
    const originalCall = fake.session.call.bind(fake.session);
    fake.session.call = async (method, params, opts) => {
      if (method === "Page.captureScreenshot") order.push("cdp:capture");
      return originalCall(method, params, opts);
    };

    setDebugClicks(true);
    try {
      const result = await click(fake.client, cursor, { ref: "e1" });
      assert.equal(result.success, true);
      if (result.success) {
        assert.equal(result.data.details?.["x"], 220);
        assert.equal(result.data.details?.["y"], 320);
      }
    } finally {
      setDebugClicks(false);
    }

    assert.ok(order.indexOf("cursor:released") < order.indexOf("capture:suppressed:false"));
    assert.ok(order.indexOf("capture:suppressed:false") < order.indexOf("cdp:capture"));
  });
});
