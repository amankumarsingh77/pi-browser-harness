import { randomUUID } from "node:crypto";
import { homedir, tmpdir } from "node:os";
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

// Recordings go to a durable user directory by design, not the temp dir screenshots and PDFs use — the file is the whole point of the feature, not a byproduct.
export const recordingsDir = (): string => {
  const configured = process.env["PI_BROWSER_RECORDINGS_DIR"];
  if (configured !== undefined && configured !== "") return configured;
  return join(homedir(), ".pi", "browser-harness", "recordings");
};

// Creating the directory is the caller's job — this helper stays pure, like screenshotPath and pdfPath.
export const recordingPath = (namespace: string): string => {
  requireValidNamespace(namespace);
  return join(recordingsDir(), `recording-${namespace}-${randomUUID()}.mp4`);
};
