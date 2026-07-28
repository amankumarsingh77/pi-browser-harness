import { readFileSync } from "node:fs";
import { Type } from "typebox";
import { Image, type ImageTheme, Text, truncateToWidth, visibleWidth } from "@mariozechner/pi-tui";
import { type Result, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { asRecord, asString } from "../util/guards";
import { captureBase, resizeIfNeeded } from "./screenshot-capture";

const ScreenshotArgs = Type.Object({
  fullPage: Type.Optional(Type.Boolean({ default: false, description: "Capture beyond viewport" })),
  format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")], { default: "png" })),
  quality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 80, description: "JPEG quality 1-100" })),
  maxDim: Type.Optional(Type.Integer({ minimum: 100, maximum: 8000, description: "If max(w,h) exceeds this, resize via sharp." })),
});

export const screenshotTool = defineBrowserTool({
  name: "browser_screenshot",
  label: "Browser Screenshot",
  description:
    "Capture the page as a JPEG/PNG image. NOT a default exploration tool. Use ONLY when (a) you need to verify visual properties (layout, color, spacing, rendered text legibility), or (b) browser_snapshot and browser_execute_js cannot answer your question. For understanding what's on the page use browser_snapshot. For specific element values use browser_execute_js. For click coordinates use the @(x,y) hints in browser_snapshot's outline.",
  promptSnippet: "Capture a screenshot — visual verification only",
  promptGuidelines: [
    "DO NOT use as a default exploration tool. browser_snapshot is the default for understanding page structure — far cheaper and more reliable.",
    "DO NOT use to find click coordinates. browser_snapshot already includes @(x,y) for every interactive element. If a target isn't there, use browser_execute_js with element.getBoundingClientRect().",
    "DO use to verify visual rendering after an action: did the modal animate in correctly, did the chart render, are colors right, did the layout reflow as expected.",
    "DO use as a debugging fallback when browser_execute_js or browser_snapshot return surprising results and you suspect the rendered page differs from the DOM.",
    "format='jpeg' with quality 60-90 keeps screenshots small for photo-heavy pages. Use maxDim if the page is huge.",
  ],
  parameters: ScreenshotArgs,
  concurrency: "parallel",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
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
    const raw = asRecord(result.details);
    const filePath = raw === undefined ? undefined : asString(raw["path"]);
    if (!filePath) {
      return new Text(theme.fg("error", "Screenshot path missing"), 0, 0);
    }
    const format = raw === undefined ? undefined : asString(raw["format"]);
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
        invalidate: () => image.invalidate(),
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
