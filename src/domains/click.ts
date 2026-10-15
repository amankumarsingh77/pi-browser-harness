import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import type { BrowserClient } from "../client";
import type { CursorButton, CursorVisualSession } from "../cursor/types";
import { Coords, MouseButton } from "../schemas/common";
import { type Result, err, ok } from "../util/result";
import { debugClicksEnabled } from "../util/debug";
import { defineBrowserTool, type ToolErr } from "../util/tool";
import { cdpCall } from "./cdp-call";
import { captureWithCrosshair } from "./screenshot-capture";
import { interactiveDiff } from "./ref-resolve";
import { refreshResolvedTarget, resolveTarget, type ResolvedTarget } from "./target";

const ClickArgs = Type.Object({
  ref: Type.Optional(
    Type.String({
      description:
        "Stable element ref from browser_snapshot (e.g. 'e12'). PREFERRED over x/y — survives re-renders. When set, x/y are ignored.",
    }),
  ),
  x: Type.Optional(Coords.properties.x),
  y: Type.Optional(Coords.properties.y),
  button: Type.Optional(MouseButton),
  count: Type.Optional(
    Type.Integer({
      minimum: 1,
      maximum: 3,
      default: 1,
      description: "Number of clicks (1 = single, 2 = double). Default: 1",
    }),
  ),
});

type ClickDispatchArgs = {
  readonly target: ResolvedTarget;
  readonly button: CursorButton;
  readonly count: number;
  readonly signal?: AbortSignal;
  readonly visual: CursorVisualSession;
};

const cancelled = (): Result<never, ToolErr> =>
  err({ kind: "invalid_state", message: "Click cancelled" });

const runVisual = async (operation: () => Promise<void>): Promise<void> => {
  try {
    await operation();
  } catch {
    // Visual feedback is best-effort; CDP input remains authoritative.
  }
};

const dispatchClick = async (
  client: BrowserClient,
  args: ClickDispatchArgs,
): Promise<Result<ResolvedTarget, ToolErr>> => {
  if (args.signal?.aborted) return cancelled();
  await runVisual(() => args.visual.moveTo(args.target));
  await runVisual(() => args.visual.waitForMove());
  if (args.signal?.aborted) return cancelled();

  const refreshed = await refreshResolvedTarget(client, args.target);
  if (!refreshed.success) return refreshed;
  const target = refreshed.data;
  if (args.signal?.aborted) return cancelled();
  if (target.x !== args.target.x || target.y !== args.target.y) {
    await runVisual(() => args.visual.moveTo(target, true));
  }
  if (args.signal?.aborted) return cancelled();

  // Some focus/hover handlers and React synthetic events only fire when a mousemove precedes the press, so without it a click lands without focusing.
  const moved = await cdpCall(client, "Input.dispatchMouseEvent", {
    type: "mouseMoved",
    x: target.x,
    y: target.y,
  });
  if (!moved.success) return moved;
  if (args.signal?.aborted) return cancelled();

  await runVisual(() => args.visual.press(args.button));
  const pressed = await cdpCall(client, "Input.dispatchMouseEvent", {
    type: "mousePressed",
    x: target.x,
    y: target.y,
    button: args.button,
    clickCount: args.count,
  });
  if (!pressed.success) {
    await runVisual(() => args.visual.release(args.button, args.count));
    return pressed;
  }

  const released = await cdpCall(client, "Input.dispatchMouseEvent", {
    type: "mouseReleased",
    x: target.x,
    y: target.y,
    button: args.button,
    clickCount: args.count,
  });
  await runVisual(() => args.visual.release(args.button, args.count));
  if (!released.success) return released;
  if (args.signal?.aborted) return cancelled();
  return ok(target);
};

export const clickTool = defineBrowserTool({
  name: "browser_click",
  label: "Browser Click",
  description:
    "Click an element. PREFERRED: pass `ref` (e.g. 'e12') from browser_snapshot — it re-resolves the element's position at click time, so it works even after the page re-renders and moves things. Fallback: pass viewport CSS-pixel `x`/`y`. Compositor-level click works through iframes, shadow DOM, and cross-origin content. After clicking, a compact diff of page changes is appended.",
  promptSnippet: "Click an element by ref (preferred) or pixel coordinates",
  promptGuidelines: [
    "If a click doesn't register, run pi with --browser-debug-clicks (or set BH_DEBUG_CLICKS=1) to get annotated screenshots. For React/Vue components ignoring clicks, try browser_dispatch_key.",
  ],
  parameters: ClickArgs,
  concurrency: "serialized",
  renderCall: (a) => new Text(`🖱️ Click ${a.ref ? `[${a.ref}]` : `(${a.x}, ${a.y})`}`, 0, 0),
  async handler(args, { client, cursor, signal }) {
    const button = args.button ?? "left";
    const count = args.count ?? 1;

    const resolved = await resolveTarget(client, args);
    if (!resolved.success) return resolved;
    const current = client.current();
    if (!current) {
      return err({ kind: "not_connected", message: "No browser page is attached" });
    }
    const clicked = await cursor.runPointerAction(current, signal, async (visual) =>
      dispatchClick(client, {
        target: resolved.data,
        button,
        count,
        visual,
        ...(signal === undefined ? {} : { signal }),
      }));
    if (!clicked.success) return err(clicked.error);
    const target = clicked.data;
    const cursorDetails = {
      cursorVisual: clicked.diagnostics.status,
      ...(clicked.diagnostics.reason === undefined ? {} : { cursorReason: clicked.diagnostics.reason }),
    };

    const diff = await interactiveDiff(client);
    if (debugClicksEnabled()) {
      const debug = await cursor.withCaptureVisibility(false, (captureTarget) =>
        captureWithCrosshair(client, { x: target.x, y: target.y }, captureTarget.sessionId));
      if (debug.success) {
        return ok({
          text: `Clicked at ${target.label}\n[DEBUG] Overlay screenshot: ${debug.data.path}${diff}`,
          details: {
            debugScreenshotPath: debug.data.path,
            x: target.x,
            y: target.y,
            ref: args.ref,
            ...cursorDetails,
          },
        });
      }
    }
    return ok({
      text: `Clicked at ${target.label}${diff}`,
      details: { x: target.x, y: target.y, ref: args.ref, ...cursorDetails },
    });
  },
});
