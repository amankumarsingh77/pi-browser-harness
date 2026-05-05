import { Type, type Static } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import type { BrowserClient } from "../client";
import { Coords, MouseButton } from "../schemas/common";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr } from "../util/tool";
import { captureWithCrosshair } from "./screenshot";

const ClickArgs = Type.Object({
  ...Coords.properties,
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
type ClickArgsT = Static<typeof ClickArgs>;

const dispatchClick = async (
  client: BrowserClient,
  args: ClickArgsT,
): Promise<Result<void, ToolErr>> => {
  const button = args.button ?? "left";
  const count = args.count ?? 1;
  const pressed = await client.session().call("Input.dispatchMouseEvent", {
    type: "mousePressed", x: args.x, y: args.y, button, clickCount: count,
  });
  if (!pressed.success) return err({ kind: "cdp_error", message: pressed.error.message });
  const released = await client.session().call("Input.dispatchMouseEvent", {
    type: "mouseReleased", x: args.x, y: args.y, button, clickCount: count,
  });
  if (!released.success) return err({ kind: "cdp_error", message: released.error.message });
  return ok(undefined);
};

export const clickTool = defineBrowserTool({
  name: "browser_click",
  label: "Browser Click",
  description:
    "Click at viewport CSS-pixel coordinates. Compositor-level click works through iframes, shadow DOM, and cross-origin content. Get coordinates from browser_snapshot's @(x,y) hints — do not screenshot to find click targets.",
  promptSnippet: "Click at pixel coordinates (x, y) on the page",
  promptGuidelines: [
    "Get (x, y) from browser_snapshot — the outline shows '@(x,y)' for every interactive element. NO screenshot needed.",
    "If the target isn't an interactive role in the snapshot, fall back to browser_execute_js with `el.getBoundingClientRect()` — still NO screenshot.",
    "Coordinates are viewport CSS pixels (not device pixels).",
    "After clicking, verify with browser_snapshot (or browser_execute_js for a specific value). Only screenshot if you need to confirm visual rendering.",
    "Compositor-level clicks pass through iframes, shadow DOM, and cross-origin content — no selector needed.",
    "If a click doesn't register, set BH_DEBUG_CLICKS=1 to get annotated screenshots showing exact click positions (debug only).",
    "For React/Vue components that don't respond to clicks, try browser_dispatch_key to send DOM-level events.",
  ],
  parameters: ClickArgs,
  renderCall: (a) => new Text(`🖱️ Click at (${a.x}, ${a.y})`, 0, 0),
  async handler(args, { client }) {
    const clicked = await dispatchClick(client, args);
    if (!clicked.success) return clicked;
    if (process.env["BH_DEBUG_CLICKS"]) {
      const debug = await captureWithCrosshair(client, { x: args.x, y: args.y });
      if (debug.success) {
        return ok({
          text: `Clicked at (${args.x}, ${args.y})\n[DEBUG] Overlay screenshot: ${debug.data.path}`,
          details: { debugScreenshotPath: debug.data.path, x: args.x, y: args.y },
        });
      }
    }
    return ok({
      text: `Clicked at (${args.x}, ${args.y})`,
      details: { x: args.x, y: args.y },
    });
  },
});
