import { Type } from "typebox";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";

const ScrollArgs = Type.Object({
  x: Type.Optional(Type.Number({ description: "X coordinate where to scroll. Default: viewport center" })),
  y: Type.Optional(Type.Number({ description: "Y coordinate where to scroll. Default: viewport center" })),
  deltaX: Type.Optional(Type.Number({ default: 0, description: "Horizontal scroll delta (CSS pixels). Positive = right." })),
  deltaY: Type.Optional(Type.Number({
    default: -300,
    description: "Vertical scroll delta (CSS pixels). Positive = up (matches W3C wheel events). Default: -300 (scroll down).",
  })),
});

export const scrollTool = defineBrowserTool({
  name: "browser_scroll",
  label: "Browser Scroll",
  description:
    "Scroll the page at given coordinates. deltaY follows W3C wheel-event convention: positive = scroll up, negative = scroll down. Default scrolls down (deltaY = -300).",
  promptSnippet: "Scroll the page (deltaY positive=up, negative=down)",
  promptGuidelines: [
    "Default behavior scrolls down 300px (deltaY=-300). Pass a positive deltaY to scroll up.",
    "Pass x/y to target a specific scrollable region (e.g., a div with overflow); otherwise scrolls the page at viewport center.",
  ],
  parameters: ScrollArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const info = await client.pageInfo();
    if (!info.success) return err({ kind: "cdp_error", message: info.error.message });
    if ("dialog" in info.data) {
      return err({
        kind: "invalid_state",
        message: `Dialog open: ${info.data.dialog.type} — ${info.data.dialog.message}`,
      });
    }
    const cx = args.x ?? Math.round(info.data.width / 2);
    const cy = args.y ?? Math.round(info.data.height / 2);
    const dx = args.deltaX ?? 0;
    const dy = args.deltaY ?? -300;
    // Establish compositor mouse position before mouseWheel; without this,
    // CDP sometimes drops the wheel event with a timeout. Fix preserved
    // from v0.2.0.
    const moved = await client.session().call("Input.dispatchMouseEvent", { type: "mouseMoved", x: cx, y: cy });
    if (!moved.success) return err({ kind: "cdp_error", message: moved.error.message });
    const wheel = await client.session().call("Input.dispatchMouseEvent", {
      type: "mouseWheel", x: cx, y: cy, deltaX: dx, deltaY: dy,
    });
    if (!wheel.success) return err({ kind: "cdp_error", message: wheel.error.message });
    return ok({
      text: `Scrolled at (${cx}, ${cy}) by (${dx}, ${dy})`,
      details: { x: cx, y: cy, deltaX: dx, deltaY: dy },
    });
  },
});
