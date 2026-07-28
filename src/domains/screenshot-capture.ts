import { rename, writeFile } from "node:fs/promises";
import type { BrowserClient } from "../client";
import { type Result, ok } from "../util/result";
import type { ToolErr } from "../util/tool";
import { screenshotPath } from "../util/paths";
import { loadSharp } from "../util/sharp-shim";
import { safeJs } from "../util/js-template";
import { cdpCall, evalJs } from "./cdp-call";

export type CaptureArgs = {
  readonly fullPage?: boolean;
  readonly format?: "png" | "jpeg";
  readonly quality?: number;
};

export const captureBase = async (
  client: BrowserClient,
  args: CaptureArgs,
): Promise<Result<{ readonly path: string; readonly format: "png" | "jpeg" }, ToolErr>> => {
  const format = args.format ?? "png";
  const quality = args.quality ?? 80;
  const path = screenshotPath(client.namespace, format);
  const r = await cdpCall(client, "Page.captureScreenshot", {
    format,
    captureBeyondViewport: args.fullPage ?? false,
    ...(format === "jpeg" ? { quality } : {}),
  });
  if (!r.success) return r;
  await writeFile(path, Buffer.from(r.data.data, "base64"));
  return ok({ path, format });
};

export const resizeIfNeeded = async (
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

export const captureWithCrosshair = async (
  client: BrowserClient,
  args: { readonly x: number; readonly y: number; readonly format?: "png" | "jpeg"; readonly quality?: number },
): Promise<Result<{ readonly path: string }, ToolErr>> => {
  const cap = await captureBase(client, args);
  if (!cap.success) return cap;
  const load = await loadSharp();
  if (load.kind !== "ok") return ok({ path: cap.data.path });
  try {
    const dprR = await evalJs(client, safeJs`window.devicePixelRatio`);
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
    return ok({ path: cap.data.path });
  }
};
