import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  DEFAULT_MAX_BYTES,
  DEFAULT_MAX_LINES,
  formatSize,
  truncateHead,
  withFileMutationQueue,
} from "@mariozechner/pi-coding-agent";

const tempDirs: string[] = [];

export const cleanupTempDirs = async (): Promise<void> => {
  const dirs = tempDirs.splice(0);
  await Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }).catch(() => {})));
};

export type TruncatedOutput = {
  readonly text: string;
  readonly fullOutputPath?: string;
  readonly wasTruncated: boolean;
};

export const applyTruncation = async (output: string, prefix: string): Promise<TruncatedOutput> => {
  const t = truncateHead(output, { maxLines: DEFAULT_MAX_LINES, maxBytes: DEFAULT_MAX_BYTES });
  if (!t.truncated) return { text: t.content, wasTruncated: false };
  const dir = await mkdtemp(join(tmpdir(), `pi-bh-${prefix}-`));
  tempDirs.push(dir);
  const file = join(dir, "output.txt");
  await withFileMutationQueue(file, async () => { await writeFile(file, output, "utf8"); });
  const omitted = t.totalBytes - t.outputBytes;
  const text = `${t.content}\n\n[Output truncated: ${t.outputLines} of ${t.totalLines} lines (${formatSize(t.outputBytes)} of ${formatSize(t.totalBytes)}). ${formatSize(omitted)} omitted. Full output: ${file}]`;
  return { text, fullOutputPath: file, wasTruncated: true };
};
