import { writeFile } from "node:fs/promises";
import { Type, type Static } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import type { BrowserClient } from "../client";
import { Coords, MouseButton } from "../schemas/common";
import { screenshotPath } from "../util/paths";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr } from "../util/tool";

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
    "Click at viewport CSS-pixel coordinates. Compositor-level click works through iframes, shadow DOM, and cross-origin content. Use browser_screenshot first to find coordinates.",
  promptSnippet: "Click at pixel coordinates (x, y) on the page",
  promptGuidelines: [
    "Use browser_click for all clicks. Coordinates are viewport CSS pixels (not device pixels).",
    "Capture a browser_screenshot BEFORE clicking to find the right coordinates.",
    "Capture another browser_screenshot AFTER clicking to verify the action worked.",
    "Compositor-level clicks pass through iframes, shadow DOM, and cross-origin content — no selector needed.",
    "If a click doesn't register, try setting BH_DEBUG_CLICKS=1 to get annotated screenshots showing exact click positions.",
    "For React/Vue components that don't respond to clicks, try browser_dispatch_key to send DOM-level events.",
  ],
  parameters: ClickArgs,
  renderCall: (a) => new Text(`🖱️ Click at (${a.x}, ${a.y})`, 0, 0),
  async handler(args, { client }) {
    const clicked = await dispatchClick(client, args);
    if (!clicked.success) return clicked;
    if (process.env["BH_DEBUG_CLICKS"]) {
      // Plain screenshot for now; the crosshair overlay returns in Task 14
      // (domains/screenshot.ts) once sharp-shim lands.
      const path = screenshotPath(client.namespace, "png");
      const shot = await client.session().call("Page.captureScreenshot", { format: "png" });
      if (shot.success) {
        const data = (shot.data as { data: string }).data;
        await writeFile(path, Buffer.from(data, "base64"));
        return ok({
          text: `Clicked at (${args.x}, ${args.y})\n[DEBUG] Screenshot: ${path}`,
          details: { debugScreenshotPath: path, x: args.x, y: args.y },
        });
      }
    }
    return ok({
      text: `Clicked at (${args.x}, ${args.y})`,
      details: { x: args.x, y: args.y },
    });
  },
});
