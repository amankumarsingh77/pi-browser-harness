import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import type { BrowserClient } from "../client";
import { Coords, MouseButton } from "../schemas/common";
import { type Result, ok } from "../util/result";
import { defineBrowserTool, type ToolErr } from "../util/tool";
import { cdpCall } from "./cdp-call";
import { captureWithCrosshair } from "./screenshot";
import { interactiveDiff } from "./ref-resolve";
import { resolveTarget } from "./target";

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

const dispatchClick = async (
  client: BrowserClient,
  x: number,
  y: number,
  button: "left" | "right" | "middle",
  count: number,
): Promise<Result<void, ToolErr>> => {
  // Some focus/hover handlers and React synthetic events only fire when a mousemove precedes the press, so without it a click lands without focusing.
  const moved = await cdpCall(client, "Input.dispatchMouseEvent", { type: "mouseMoved", x, y });
  if (!moved.success) return moved;
  const pressed = await cdpCall(client, "Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button, clickCount: count,
  });
  if (!pressed.success) return pressed;
  const released = await cdpCall(client, "Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button, clickCount: count,
  });
  if (!released.success) return released;
  return ok(undefined);
};

export const clickTool = defineBrowserTool({
  name: "browser_click",
  label: "Browser Click",
  description:
    "Click an element. PREFERRED: pass `ref` (e.g. 'e12') from browser_snapshot — it re-resolves the element's position at click time, so it works even after the page re-renders and moves things. Fallback: pass viewport CSS-pixel `x`/`y`. Compositor-level click works through iframes, shadow DOM, and cross-origin content. After clicking, a compact diff of page changes is appended.",
  promptSnippet: "Click an element by ref (preferred) or pixel coordinates",
  promptGuidelines: [
    "PREFER `ref` from browser_snapshot (the outline shows '[eN]' for every interactive element) — it survives re-renders, unlike coordinates which go stale after a save/edit reflows the page.",
    "Fallback: pass (x, y) from the snapshot's '@(x,y)' hint when there's no ref.",
    "A 'ref is stale' error means the page changed — re-run browser_snapshot to get fresh refs.",
    "After clicking, read the appended page-changes diff to confirm the action landed before moving on (no separate snapshot needed for a quick check).",
    "Coordinates are viewport CSS pixels (not device pixels). Compositor-level clicks pass through iframes, shadow DOM, and cross-origin content.",
    "If a click doesn't register, set BH_DEBUG_CLICKS=1 to get annotated screenshots (debug only). For React/Vue components ignoring clicks, try browser_dispatch_key.",
  ],
  parameters: ClickArgs,
  concurrency: "serialized",
  renderCall: (a) => new Text(`🖱️ Click ${a.ref ? `[${a.ref}]` : `(${a.x}, ${a.y})`}`, 0, 0),
  async handler(args, { client }) {
    const button = args.button ?? "left";
    const count = args.count ?? 1;

    const resolved = await resolveTarget(client, args);
    if (!resolved.success) return resolved;
    const { x, y, label: target } = resolved.data;

    const clicked = await dispatchClick(client, x, y, button, count);
    if (!clicked.success) return clicked;

    const diff = await interactiveDiff(client);
    if (process.env["BH_DEBUG_CLICKS"]) {
      const debug = await captureWithCrosshair(client, { x, y });
      if (debug.success) {
        return ok({
          text: `Clicked at ${target}\n[DEBUG] Overlay screenshot: ${debug.data.path}${diff}`,
          details: { debugScreenshotPath: debug.data.path, x, y, ref: args.ref },
        });
      }
    }
    return ok({
      text: `Clicked at ${target}${diff}`,
      details: { x, y, ref: args.ref },
    });
  },
});
