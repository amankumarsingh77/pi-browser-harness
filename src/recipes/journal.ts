import { appendFile, mkdir, readdir, readFile, stat, unlink } from "node:fs/promises";
import { join } from "node:path";
import { agentDir } from "../profile/paths";
import type { JsonObject } from "../util/tool";

export type Locator =
  | { readonly role: string; readonly name: string; readonly nth: number }
  | { readonly css: string }
  | { readonly x: number; readonly y: number };

export type ObservedChange = {
  readonly url?: string;
  readonly appeared: ReadonlyArray<{ readonly role: string; readonly name: string }>;
  readonly dialog?: string;
  readonly download?: boolean;
};

export type JournalFieldEntry = { readonly locator?: Locator; readonly value: string; readonly password: boolean };

// One page-changing call. `args` holds the tool's arguments minus the element handle (ref, selector, x/y),
// which lives in `locator`; a password value is replaced by "" and flagged, never stored.
export type JournalEntry = {
  readonly v: 1;
  readonly at: string;
  readonly run: number;
  readonly source: "agent" | "replay";
  readonly tool: string;
  readonly replayable: boolean;
  readonly args: JsonObject;
  readonly locator?: Locator;
  readonly fields?: ReadonlyArray<JournalFieldEntry>;
  readonly password: boolean;
  readonly url: string;
  readonly ok: boolean;
  readonly error?: string;
  readonly change?: ObservedChange;
};

export type NewEntry = Omit<JournalEntry, "v" | "at" | "run">;

export type Journal = {
  readonly path: string;
  readonly beginRun: () => Promise<number>;
  readonly append: (e: NewEntry) => Promise<void>;
  readonly entries: () => Promise<ReadonlyArray<JournalEntry>>;
};

const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

export const journalDir = (): string => join(agentDir(), "browser-harness", "journal");

const isEntry = (v: unknown): v is JournalEntry =>
  typeof v === "object" && v !== null && "v" in v && v.v === 1 && "run" in v && typeof v.run === "number";

const readEntries = async (path: string): Promise<ReadonlyArray<JournalEntry>> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return [];
  }
  const out: JournalEntry[] = [];
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed: unknown = JSON.parse(line);
      if (isEntry(parsed)) out.push(parsed);
    } catch {
      // A torn last line from a crash mid-append is skipped, not fatal.
    }
  }
  return out;
};

const pruneOld = async (dir: string, now: number): Promise<void> => {
  let names: string[];
  try {
    names = await readdir(dir);
  } catch {
    return;
  }
  for (const name of names) {
    if (!name.endsWith(".jsonl")) continue;
    const file = join(dir, name);
    const info = await stat(file).catch(() => undefined);
    if (info && now - info.mtimeMs > RETENTION_MS) await unlink(file).catch(() => undefined);
  }
};

export const createJournal = (dir: string, sessionId: string, now: () => number = Date.now): Journal => {
  const path = join(dir, `${sessionId}.jsonl`);
  let run: number | undefined;
  void pruneOld(dir, now());
  return {
    path,
    beginRun: async () => {
      if (run === undefined) {
        const existing = await readEntries(path);
        run = existing.reduce((max, e) => Math.max(max, e.run), 0);
      }
      run += 1;
      return run;
    },
    append: async (e) => {
      const entry: JournalEntry = { v: 1, at: new Date(now()).toISOString(), run: run ?? 0, ...e };
      await mkdir(dir, { recursive: true, mode: 0o700 });
      await appendFile(path, `${JSON.stringify(entry)}\n`, { encoding: "utf8", mode: 0o600 });
    },
    entries: () => readEntries(path),
  };
};

let active: Journal | undefined;
export const activeJournal = (): Journal | undefined => active;
export const setActiveJournal = (j: Journal | undefined): void => {
  active = j;
};
