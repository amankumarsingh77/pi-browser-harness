import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

export const screenshotPath = (namespace: string, ext: "png" | "jpeg" = "png"): string =>
  join(tmpdir(), `pi-browser-screenshot-${namespace}-${randomUUID()}.${ext}`);

export const pdfPath = (namespace: string): string =>
  join(tmpdir(), `pi-browser-pdf-${namespace}-${randomUUID()}.pdf`);
