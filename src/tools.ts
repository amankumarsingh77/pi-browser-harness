/**
 * Tool registrations for pi-browser-harness.
 *
 * Maps browser-harness daemon methods to pi tools with TypeBox schemas,
 * prompt snippets, guidelines, and TUI renderers.
 */

import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Text } from "@mariozechner/pi-tui";
import { Type } from "typebox";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { BrowserDaemon } from "./daemon";
import type { TabInfo } from "./protocol";

// ── AsyncFunction constructor ────────────────────────────────────────────────

const AsyncFunction = Object.getPrototypeOf(async () => {}).constructor as new (...args: string[]) => (...args: unknown[]) => Promise<unknown>;

// ── Key code map ─────────────────────────────────────────────────────────────

const SPECIAL_KEYS = [
  "Enter", "Tab", "Backspace", "Escape", "Delete",
  "ArrowLeft", "ArrowUp", "ArrowRight", "ArrowDown",
  "Home", "End", "PageUp", "PageDown", " ",
];

// ── Screenshot path ──────────────────────────────────────────────────────────

let screenshotCounter = 0;
function nextScreenshotPath(): string {
  screenshotCounter++;
  return join(tmpdir(), `pi-browser-screenshot-${Date.now()}-${screenshotCounter}.png`);
}

// ── Output truncation ────────────────────────────────────────────────────────

/** Track temp directories for cleanup on session shutdown. */
const tempDirs: string[] = [];

/** Best-effort cleanup of all tracked temp directories. */
export async function cleanupTempDirs(): Promise<void> {
  const dirs = tempDirs.splice(0);
  await Promise.all(
    dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})),
  );
}

/**
 * Truncate output to pi's built-in limits (50KB / 2000 lines).
 * When truncated, writes the full output to a temp file so the LLM
 * can read it via the read tool and so CTRL+O expand can show it.
 */
async function applyTruncation(
  output: string,
  prefix: string,
): Promise<{
  text: string;
  fullOutputPath?: string;
  wasTruncated: boolean;
}> {
  const truncation = truncateHead(output, {
    maxLines: DEFAULT_MAX_LINES,
    maxBytes: DEFAULT_MAX_BYTES,
  });

  if (!truncation.truncated) {
    return { text: truncation.content, wasTruncated: false };
  }

  const tempDir = await mkdtemp(join(tmpdir(), `pi-bh-${prefix}-`));
  tempDirs.push(tempDir);

  const tempFile = join(tempDir, "output.txt");
  await withFileMutationQueue(tempFile, async () => {
    await writeFile(tempFile, output, "utf8");
  });

  const omittedBytes = truncation.totalBytes - truncation.outputBytes;
  let text = truncation.content;
  text += `\n\n[Output truncated: ${truncation.outputLines} of ${truncation.totalLines} lines`;
  text += ` (${formatSize(truncation.outputBytes)} of ${formatSize(truncation.totalBytes)}).`;
  text += ` ${formatSize(omittedBytes)} omitted. Full output: ${tempFile}]`;

  return { text, fullOutputPath: tempFile, wasTruncated: true };
}

// ── Registration ─────────────────────────────────────────────────────────────

// All tools migrated to src/domains/* in v0.3 — see registerAllTools.
export function registerTools(_pi: ExtensionAPI, _daemon: BrowserDaemon): void {
  // intentionally empty
}
