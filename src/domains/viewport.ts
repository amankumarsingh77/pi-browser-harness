import { Type } from "typebox";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";

const ViewportArgs = Type.Object({
  width: Type.Integer({ minimum: 100, maximum: 8000, description: "Viewport CSS pixel width" }),
  height: Type.Integer({ minimum: 100, maximum: 8000, description: "Viewport CSS pixel height" }),
  deviceScaleFactor: Type.Optional(
    Type.Number({ minimum: 0.5, maximum: 4, default: 1, description: "Device pixel ratio" }),
  ),
});

export const viewportResizeTool = defineBrowserTool({
  name: "browser_viewport_resize",
  label: "Browser Viewport Resize",
  description: "Override the viewport size and device pixel ratio for responsive testing.",
  promptSnippet: "Resize the viewport (responsive testing)",
  promptGuidelines: [
    "Width/height in CSS pixels (e.g., 375x667 for iPhone SE).",
    "Pass deviceScaleFactor=2 to simulate retina displays.",
  ],
  parameters: ViewportArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await client.session().call("Emulation.setDeviceMetricsOverride", {
      width: args.width,
      height: args.height,
      deviceScaleFactor: args.deviceScaleFactor ?? 1,
      mobile: false,
    });
    if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
    return ok({
      text: `Viewport set to ${args.width}x${args.height} @${args.deviceScaleFactor ?? 1}x`,
      details: {
        width: args.width,
        height: args.height,
        deviceScaleFactor: args.deviceScaleFactor ?? 1,
      },
    });
  },
});
