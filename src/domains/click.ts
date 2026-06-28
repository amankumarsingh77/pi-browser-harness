import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import type { BrowserClient } from "../client";
import { Coords, MouseButton } from "../schemas/common";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr } from "../util/tool";
import { captureWithCrosshair } from "./screenshot";
import { interactiveDiff, resolveRefToBox } from "./ref-resolve";

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
  // Move the pointer to the target first. Some focus/hover handlers (and React
  // synthetic events) only fire when a mousemove precedes the press, so without
  // it a click can land without focusing the element.
  const moved = await client.session().call("Input.dispatchMouseEvent", {
    type: "mouseMoved", x, y,
  });
  if (!moved.success) return err({ kind: "cdp_error", message: moved.error.message });
  const pressed = await client.session().call("Input.dispatchMouseEvent", {
    type: "mousePressed", x, y, button, clickCount: count,
  });
  if (!pressed.success) return err({ kind: "cdp_error", message: pressed.error.message });
  const released = await client.session().call("Input.dispatchMouseEvent", {
    type: "mouseReleased", x, y, button, clickCount: count,
  });
  if (!released.success) return err({ kind: "cdp_error", message: released.error.message });
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
  renderCall: (a) => new Text(`🖱️ Click ${a.ref ? `[${a.ref}]` : `(${a.x}, ${a.y})`}`, 0, 0),
  async handler(args, { client }) {
    const button = args.button ?? "left";
    const count = args.count ?? 1;

    // Resolve the click point: ref re-resolves to the element's CURRENT box
    // (so re-renders don't matter); otherwise use the literal x/y.
    let x: number;
    let y: number;
    if (args.ref !== undefined) {
      const box = await resolveRefToBox(client, args.ref);
      if (!box.success) return box;
      x = box.data.cx;
      y = box.data.cy;
    } else if (args.x !== undefined && args.y !== undefined) {
      x = args.x;
      y = args.y;
    } else {
      return err({ kind: "invalid_state", message: "Provide either `ref` or both `x` and `y`." });
    }

    const clicked = await dispatchClick(client, x, y, button, count);
    if (!clicked.success) return clicked;

    const target = args.ref !== undefined ? `[${args.ref}] (${x}, ${y})` : `(${x}, ${y})`;
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
