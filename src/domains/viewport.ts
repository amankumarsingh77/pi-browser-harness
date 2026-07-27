import { Type } from "typebox";
import { type Result, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { cdpCall } from "./cdp-call";

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
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await cdpCall(client, "Emulation.setDeviceMetricsOverride", {
      width: args.width,
      height: args.height,
      deviceScaleFactor: args.deviceScaleFactor ?? 1,
      mobile: false,
    });
    if (!r.success) return r;
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
