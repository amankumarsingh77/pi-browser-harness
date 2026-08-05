import { randomUUID } from "node:crypto";
import { tmpdir } from "node:os";
import { isAbsolute, join, relative, resolve } from "node:path";

// `relative` rather than a string prefix: it is separator-agnostic and carries each platform's
// own case rules, so a Windows path is not rejected for its backslashes or its drive-letter case.
export const isPathWithin = (root: string, target: string): boolean => {
  const absRoot = resolve(root);
  const absTarget = resolve(target);
  if (absTarget === absRoot) return true;
  const rel = relative(absRoot, absTarget);
  return rel !== "" && !rel.startsWith("..") && !isAbsolute(rel);
};

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
