import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { join } from "node:path";

const NAMESPACE_RE = /^[a-zA-Z0-9_-]+$/;

const requireValidNamespace = (namespace: string): void => {
  if (!NAMESPACE_RE.test(namespace)) {
    throw new Error(`Invalid namespace (must match ${NAMESPACE_RE}): ${JSON.stringify(namespace)}`);
  }
};

export const screenshotPath = (namespace: string, ext: "png" | "jpeg" = "png"): string => {
  requireValidNamespace(namespace);
  return join(tmpdir(), `pi-browser-screenshot-${namespace}-${randomUUID()}.${ext}`);
};

export const pdfPath = (namespace: string): string => {
  requireValidNamespace(namespace);
  return join(tmpdir(), `pi-browser-pdf-${namespace}-${randomUUID()}.pdf`);
};
