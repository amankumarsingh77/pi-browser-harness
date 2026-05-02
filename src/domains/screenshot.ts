import { writeFile, rename } from "node:fs/promises";
import { Type } from "typebox";
import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { screenshotPath } from "../util/paths";
import { loadSharp } from "../util/sharp-shim";
import { safeJs } from "../util/js-template";

const ScreenshotArgs = Type.Object({
  fullPage: Type.Optional(Type.Boolean({ default: false, description: "Capture beyond viewport" })),
  format: Type.Optional(Type.Union([Type.Literal("png"), Type.Literal("jpeg")], { default: "png" })),
  quality: Type.Optional(Type.Integer({ minimum: 1, maximum: 100, default: 80, description: "JPEG quality 1-100" })),
  maxDim: Type.Optional(Type.Integer({ minimum: 100, maximum: 8000, description: "If max(w,h) exceeds this, resize via sharp." })),
});

type CaptureArgs = {
  readonly fullPage?: boolean;
  readonly format?: "png" | "jpeg";
  readonly quality?: number;
};

const captureBase = async (
  client: BrowserClient,
  args: CaptureArgs,
): Promise<Result<{ readonly path: string; readonly format: "png" | "jpeg" }, ToolErr>> => {
  const format = args.format ?? "png";
  const quality = args.quality ?? 80;
  const path = screenshotPath(client.namespace, format);
  const params: Record<string, unknown> = { format, captureBeyondViewport: args.fullPage ?? false };
  if (format === "jpeg") params["quality"] = quality;
  const r = await client.session().call("Page.captureScreenshot", params);
  if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
  // Page.captureScreenshot returns { data: base64 }
  const data = (r.data as { data: string }).data;
  await writeFile(path, Buffer.from(data, "base64"));
  return ok({ path, format });
};

const resizeIfNeeded = async (
  path: string,
  maxDim: number,
): Promise<{ readonly note: string }> => {
  const load = await loadSharp();
  if (load.kind === "missing") return { note: " (maxDim ignored: install sharp for auto-resize)" };
  if (load.kind === "error") return { note: ` (maxDim ignored: sharp failed to load: ${load.message})` };
  try {
    const meta = await load.sharp(path).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    if (Math.max(w, h) <= maxDim) return { note: "" };
    const tmp = `${path}.resized`;
    await load.sharp(path).resize(maxDim, maxDim, { fit: "inside" }).toFile(tmp);
    await rename(tmp, path);
    return { note: ` (resized to fit ${maxDim}px)` };
  } catch (e) {
    return { note: ` (maxDim ignored: sharp threw: ${e instanceof Error ? e.message : String(e)})` };
  }
};

export const screenshotTool = defineBrowserTool({
  name: "browser_screenshot",
  label: "Browser Screenshot",
  description: "Capture the current page as PNG or JPEG. JPEG is 2-5x smaller — prefer it for photo-heavy pages.",
  promptSnippet: "Capture a screenshot of the current page",
  promptGuidelines: [
    "Use BEFORE clicks/scrolls to find coordinates; AFTER to verify the action.",
    "Pass format='jpeg' with a quality (60-90) for smaller files on photo-heavy pages.",
    "Set maxDim if the page is huge and you want to fit under LLM image-size limits.",
  ],
  parameters: ScreenshotArgs,
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
});

export const captureWithCrosshair = async (
  client: BrowserClient,
  args: { readonly x: number; readonly y: number; readonly format?: "png" | "jpeg"; readonly quality?: number },
): Promise<Result<{ readonly path: string }, ToolErr>> => {
  const cap = await captureBase(client, args);
  if (!cap.success) return cap;
  const load = await loadSharp();
  if (load.kind !== "ok") return ok({ path: cap.data.path });
  try {
    const dprR = await client.evaluateJs(safeJs`window.devicePixelRatio`);
    const dpr = dprR.success && typeof dprR.data === "number" ? dprR.data : 1;
    const meta = await load.sharp(cap.data.path).metadata();
    const w = meta.width ?? 0;
    const h = meta.height ?? 0;
    const px = Math.round(args.x * dpr);
    const py = Math.round(args.y * dpr);
    const r = Math.round(15 * dpr);
    const stroke = Math.max(2, Math.round(3 * dpr));
    const svg = `<svg width="${w}" height="${h}"><circle cx="${px}" cy="${py}" r="${r}" fill="none" stroke="red" stroke-width="${stroke}" opacity="0.8"/><line x1="${px - r - 5}" y1="${py}" x2="${px + r + 5}" y2="${py}" stroke="red" stroke-width="${Math.max(1, stroke - 1)}" opacity="0.8"/><line x1="${px}" y1="${py - r - 5}" x2="${px}" y2="${py + r + 5}" stroke="red" stroke-width="${Math.max(1, stroke - 1)}" opacity="0.8"/></svg>`;
    const tmp = `${cap.data.path}.debug`;
    await load.sharp(cap.data.path).composite([{ input: Buffer.from(svg), top: 0, left: 0 }]).toFile(tmp);
    await rename(tmp, cap.data.path);
    return ok({ path: cap.data.path });
  } catch {
    // Crosshair overlay is best-effort; on failure return the plain screenshot.
    return ok({ path: cap.data.path });
  }
};
