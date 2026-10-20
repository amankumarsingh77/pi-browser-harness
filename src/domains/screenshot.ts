import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Image, type ImageTheme, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { type Result, ok } from "../util/result";
import { type DetailsOf, defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { captureBase, resizeIfNeeded } from "./screenshot-capture";

const ScreenshotArgs = Type.Object({
  fullPage: Type.Optional(Type.Boolean({ default: false, description: "Capture beyond viewport" })),
  format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")], { default: "png" })),
  quality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 80, description: "JPEG quality 1-100" })),
  maxDim: Type.Optional(Type.Integer({ minimum: 100, maximum: 8000, description: "If max(w,h) exceeds this, resize via sharp." })),
});

const ScreenshotDetailsSchema = Type.Object({
  path: Type.String(),
  format: Type.Union([Type.Literal("png"), Type.Literal("jpeg")]),
  attached: Type.Boolean(),
});

export type ScreenshotDetails = DetailsOf<typeof ScreenshotDetailsSchema>;

export const screenshotTool = defineBrowserTool({
  name: "browser_screenshot",
  label: "Browser Screenshot",
  description:
    "Capture the page as a JPEG/PNG image. NOT a default exploration tool. Use ONLY when (a) you need to verify visual properties (layout, color, spacing, rendered text legibility), or (b) browser_snapshot and browser_execute_js cannot answer your question. For understanding what's on the page use browser_snapshot. For specific element values use browser_execute_js. For click coordinates use the @(x,y) hints in browser_snapshot's outline.",
  promptSnippet: "Capture a screenshot — visual verification only",
  promptGuidelines: [
    "format='jpeg' with quality 60-90 keeps screenshots small for photo-heavy pages. Use maxDim if the page is huge.",
  ],
  parameters: ScreenshotArgs,
  details: ScreenshotDetailsSchema,
  concurrency: "parallel",
  async handler(args, { client }): Promise<Result<ToolOk<ScreenshotDetails>, ToolErr>> {
    const cap = await captureBase(client, args);
    if (!cap.success) return cap;
    let note = "";
    if (args.maxDim !== undefined) {
      const resized = await resizeIfNeeded(cap.data.path, args.maxDim);
      note = resized.note;
    }
    return ok({
      text: `Screenshot saved: ${cap.data.path}${note}`,
      details: { path: cap.data.path, format: cap.data.format, attached: false },
    });
  },

  renderResult(result, _expanded, theme) {
    const { path: filePath, format } = result.details;
    try {
      const buf = readFileSync(filePath);
      const b64 = buf.toString("base64");
      const mimeType = format === "jpeg" ? "image/jpeg" : "image/png";
      const imageTheme: ImageTheme = {
        fallbackColor: (str: string) => theme.fg("dim", str),
      };
      const image = new Image(b64, mimeType, imageTheme, {
        maxWidthCells: 80,
        maxHeightCells: 24,
        filename: filePath,
      });
      // Image's text fallback does not respect the rendered width, so an unwrapped long path can blow past the terminal width and crash the host TUI.
      return {
        invalidate: () => { image.invalidate(); },
        render: (width: number) =>
          image.render(width).map((line) =>
            visibleWidth(line) > width ? truncateToWidth(line, width) : line,
          ),
      };
    } catch {
      return new Text(theme.fg("warning", `Screenshot saved: ${filePath}`), 0, 0);
    }
  },
});
