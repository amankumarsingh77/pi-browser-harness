import { Type } from "typebox";
import type { CursorPoint, CursorVisualSession } from "../cursor/types";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { cdpCall } from "./cdp-call";

const DragArgs = Type.Object({
  startX: Type.Number(),
  startY: Type.Number(),
  endX: Type.Number(),
  endY: Type.Number(),
  dataTransfer: Type.Optional(
    Type.Record(Type.String(), Type.String(), {
      description: "Optional MIME → data map for DataTransfer (e.g., { 'text/plain': 'hello' })",
    }),
  ),
});

export const dragPoints = (
  start: CursorPoint,
  end: CursorPoint,
  steps = 5,
): ReadonlyArray<CursorPoint> =>
  Array.from({ length: steps }, (_, i) => {
    const t = (i + 1) / steps;
    return {
      x: Math.round(start.x + (end.x - start.x) * t),
      y: Math.round(start.y + (end.y - start.y) * t),
    };
  });

const cancelledError = (): ToolErr => ({ kind: "invalid_state", message: "Drag cancelled" });

const cancelled = (): Result<never, ToolErr> => err(cancelledError());

const runVisual = async (operation: () => Promise<void>): Promise<boolean> => {
  try {
    await operation();
    return true;
  } catch {
    return false;
  }
};

const waitForDragVisual = async (): Promise<void> => {
  await new Promise<void>((resolve) => {
    setTimeout(resolve, 16);
  });
};

const isCancelDraggingUnavailable = (error: ToolErr): boolean =>
  /method not found|unsupported/i.test(error.message);

type CleanupError = { readonly method: string; readonly message: string };

const cleanupError = (method: string, error: ToolErr): CleanupError => ({
  method,
  message: error.message,
});

const withCleanupErrors = (
  primary: ToolErr,
  cleanupErrors: ReadonlyArray<CleanupError>,
): ToolErr => cleanupErrors.length === 0
  ? primary
  : {
      ...primary,
      details: {
        ...(primary.details ?? {}),
        cleanupErrors,
      },
    };

type DragDispatchArgs = {
  readonly start: CursorPoint;
  readonly end: CursorPoint;
  readonly data: {
    readonly items: ReadonlyArray<{ readonly mimeType: string; readonly data: string }>;
    readonly dragOperationsMask: number;
  };
  readonly signal: AbortSignal | undefined;
  readonly visual: CursorVisualSession;
};

const dispatchDrag = async (
  client: Parameters<typeof cdpCall>[0],
  args: DragDispatchArgs,
): Promise<Result<ToolOk, ToolErr>> => {
  let pressed = false;
  let visualPressed = false;
  let dragProtocolAttempted = false;
  let dropCompleted = false;
  let lastDeliveredPoint = args.start;
  let primary = cancelledError();
  let hasPrimary = false;
  let outcome: Result<ToolOk, ToolErr> = cancelled();
  const record = (result: Result<unknown, ToolErr>): boolean => {
    if (result.success) return true;
    primary = result.error;
    hasPrimary = true;
    return false;
  };
  const visual = async (operation: () => Promise<void>, wait = false): Promise<boolean> => {
    if (await runVisual(operation)) {
      if (wait && args.visual.isHealthy()) await waitForDragVisual();
      return true;
    }
    return false;
  };

  try {
    outcome = await (async (): Promise<Result<ToolOk, ToolErr>> => {
      if (args.signal?.aborted) return cancelled();
      await visual(() => args.visual.moveTo(args.start));
      if (args.signal?.aborted) return cancelled();
      visualPressed = await visual(() => args.visual.press("left"));
      const pressedResult = await cdpCall(client, "Input.dispatchMouseEvent", {
        type: "mousePressed",
        x: args.start.x,
        y: args.start.y,
        button: "left",
        clickCount: 1,
      });
      if (!record(pressedResult)) return err(primary);
      pressed = true;

      if (args.signal?.aborted) {
        primary = cancelledError();
        hasPrimary = true;
        return err(primary);
      }
      dragProtocolAttempted = true;
      const entered = await cdpCall(client, "Input.dispatchDragEvent", {
        type: "dragEnter",
        x: args.start.x,
        y: args.start.y,
        data: args.data,
        modifiers: 0,
      });
      if (!record(entered)) return err(primary);
      lastDeliveredPoint = args.start;

      for (const point of dragPoints(args.start, args.end)) {
        if (args.signal?.aborted) {
          primary = cancelledError();
          hasPrimary = true;
          return err(primary);
        }
        await visual(() => args.visual.moveDrag(point), true);
        const over = await cdpCall(client, "Input.dispatchDragEvent", {
          type: "dragOver",
          x: point.x,
          y: point.y,
          data: args.data,
          modifiers: 0,
        });
        if (!record(over)) return err(primary);
        lastDeliveredPoint = point;
      }

      if (args.signal?.aborted) {
        primary = cancelledError();
        hasPrimary = true;
        return err(primary);
      }
      const dropped = await cdpCall(client, "Input.dispatchDragEvent", {
        type: "drop",
        x: args.end.x,
        y: args.end.y,
        data: args.data,
        modifiers: 0,
      });
      if (!record(dropped)) return err(primary);
      dropCompleted = true;
      return ok({ text: `Dragged from (${args.start.x},${args.start.y}) to (${args.end.x},${args.end.y})` });
    })();
  } finally {
    const cleanupErrors: CleanupError[] = [];
    if (dragProtocolAttempted && !dropCompleted) {
      const cancelledDrag = await cdpCall(client, "Input.cancelDragging", {});
      if (!cancelledDrag.success) {
        cleanupErrors.push(cleanupError("Input.cancelDragging", cancelledDrag.error));
        if (isCancelDraggingUnavailable(cancelledDrag.error)) {
          const dragCancelled = await cdpCall(client, "Input.dispatchDragEvent", {
            type: "dragCancel",
            x: lastDeliveredPoint.x,
            y: lastDeliveredPoint.y,
            data: args.data,
            modifiers: 0,
          });
          if (!dragCancelled.success) cleanupErrors.push(cleanupError("Input.dispatchDragEvent", dragCancelled.error));
        }
      }
    }
    if (pressed) {
      const released = await cdpCall(client, "Input.dispatchMouseEvent", {
        type: "mouseReleased",
        x: lastDeliveredPoint.x,
        y: lastDeliveredPoint.y,
        button: "left",
        clickCount: 1,
      });
      if (!released.success) cleanupErrors.push(cleanupError("Input.dispatchMouseEvent", released.error));
    }
    if (visualPressed) {
      await runVisual(() => args.visual.release("left", 1));
    }
    if (cleanupErrors.length > 0 && hasPrimary) {
      primary = withCleanupErrors(primary, cleanupErrors);
      outcome = err(primary);
    } else if (cleanupErrors.length > 0) {
      primary = {
        kind: "cdp_error",
        message: cleanupErrors[0]?.message ?? "drag cleanup failed",
        details: { cleanupErrors },
      };
      outcome = err(primary);
    }
  }
  return outcome;
};

export const dragAndDropTool = defineBrowserTool({
  name: "browser_drag_and_drop",
  label: "Browser Drag & Drop",
  description: "Drag from (startX, startY) to (endX, endY) using CDP Input.dispatchDragEvent.",
  promptSnippet: "Drag and drop between two coordinates",
  promptGuidelines: [
    "Coordinates in CSS pixels.",
    "dataTransfer is an optional MIME→data map (e.g., { 'text/plain': 'hello' }).",
  ],
  parameters: DragArgs,
  concurrency: "serialized",
  async handler(args, { client, cursor, signal }): Promise<Result<ToolOk, ToolErr>> {
    const data = args.dataTransfer
      ? {
          items: Object.entries(args.dataTransfer).map(([mimeType, payload]) => ({
            mimeType,
            data: Buffer.from(payload).toString("base64"),
          })),
          dragOperationsMask: 1,
        }
      : { items: [], dragOperationsMask: 1 };
    const current = client.current();
    if (!current) return err({ kind: "not_connected", message: "No browser page is attached" });
    const dragged = await cursor.runPointerAction(current, signal, (visual) => dispatchDrag(client, {
      start: { x: args.startX, y: args.startY },
      end: { x: args.endX, y: args.endY },
      data,
      signal,
      visual,
    }));
    if (!dragged.success) return err(dragged.error);
    return ok({
      ...dragged.data,
      details: {
        ...(dragged.data.details ?? {}),
        cursorVisual: dragged.diagnostics.status,
        ...(dragged.diagnostics.reason === undefined ? {} : { cursorReason: dragged.diagnostics.reason }),
      },
    });
  },
});
