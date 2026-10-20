import { Type, type Static } from "typebox";
import { decodeEvent } from "./events";
import { createRecordStore, type DrainPage } from "./record-store";

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

// The one declaration of a console record: the buffer produces it and browser_console validates replayed
// details against it, so the two cannot drift.
export const ConsoleRecordSchema = Type.Object({
  seq: Type.Number(),
  timestampMs: Type.Number(),
  level: Type.Union([
    Type.Literal("log"),
    Type.Literal("info"),
    Type.Literal("warn"),
    Type.Literal("error"),
    Type.Literal("debug"),
  ]),
  text: Type.String(),
  source: Type.Union([Type.Literal("console-api"), Type.Literal("log-entry")]),
  url: Type.Optional(Type.String()),
  lineNumber: Type.Optional(Type.Number()),
  stackTrace: Type.Optional(Type.String()),
});

export type ConsoleRecord = Readonly<Static<typeof ConsoleRecordSchema>>;

export type ConsoleFilter = {
  readonly levels?: ReadonlyArray<ConsoleLevel>;
  readonly textPattern?: string;
  readonly sinceSeq?: number;
  readonly sinceMs?: number;
  readonly limit?: number;
};

export type ConsoleDrainResult = DrainPage<ConsoleRecord>;

export type ConsoleBuffer = {
  ingestConsoleApi(p: unknown): void;
  ingestLogEntry(p: unknown): void;
  drain(filter: ConsoleFilter): ConsoleDrainResult;
  clear(): void;
};

const PER_ARG_CAP = 2000;
const MAX_STACK_FRAMES = 3;

const compileTextMatcher = (pattern: string): ((text: string) => boolean) => {
  if (pattern.length >= 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
    try {
      const re = new RegExp(pattern.slice(1, -1));
      return (text) => re.test(text);
    } catch {
      // Not a valid regex: fall through and match the pattern as a literal substring.
    }
  }
  return (text) => text.includes(pattern);
};

const truncateArg = (s: string): string =>
  s.length > PER_ARG_CAP ? s.slice(0, PER_ARG_CAP) + "…" : s;

const stringifyRemoteObject = (
  arg: { type?: string; subtype?: string; value?: unknown; description?: string; unserializableValue?: string },
): string => {
  if (arg.unserializableValue !== undefined) return arg.unserializableValue;
  if (arg.value !== undefined) {
    if (typeof arg.value === "string") return arg.value;
    try {
      return JSON.stringify(arg.value);
    } catch {
      // Circular or BigInt payloads cannot be JSON-encoded; fall back to the CDP description.
      return arg.description ?? arg.type ?? "";
    }
  }
  if (arg.description !== undefined) return arg.description;
  return arg.type ?? "";
};

const mapConsoleApiLevel = (type: string | undefined): ConsoleLevel => {
  switch (type) {
    case undefined:
      return "log";
    case "error":
    case "assert":
      return "error";
    case "warning":
      return "warn";
    case "debug":
    case "trace":
      return "debug";
    case "info":
      return "info";
    default:
      return "log";
  }
};

const mapLogEntryLevel = (level: string | undefined): ConsoleLevel => {
  switch (level) {
    case undefined:
      return "info";
    case "error":
      return "error";
    case "warning":
      return "warn";
    case "verbose":
      return "debug";
    default:
      return "info";
  }
};

const formatStackTrace = (
  st: { callFrames?: ReadonlyArray<{ url?: string; lineNumber?: number; functionName?: string }> } | undefined,
): string | undefined => {
  const frames = st?.callFrames;
  if (!frames || frames.length === 0) return undefined;
  const top = frames.slice(0, MAX_STACK_FRAMES);
  const rendered = top.map((f) => {
    const fn = f.functionName !== undefined && f.functionName !== "" ? f.functionName : "<anonymous>";
    const loc = f.url !== undefined && f.url !== "" ? `${f.url}:${(f.lineNumber ?? 0) + 1}` : "<unknown>";
    return `  at ${fn} (${loc})`;
  });
  return rendered.join("\n");
};

export const createConsoleBuffer = (capacity = 500): ConsoleBuffer => {
  const records = createRecordStore<number, ConsoleRecord>(capacity);
  let nextSeq = 1;

  const insert = (rec: ConsoleRecord): void => {
    records.set(rec.seq, rec);
  };

  return {
    ingestConsoleApi(p) {
      const decoded = decodeEvent("Runtime.consoleAPICalled", p);
      if (!decoded.success) return;
      const params = decoded.data;
      const level = mapConsoleApiLevel(params.type);
      const argTexts = (params.args ?? []).map((a) => truncateArg(stringifyRemoteObject(a)));
      const text = argTexts.join(" ");
      const stack = level === "error" || level === "warn" ? formatStackTrace(params.stackTrace) : undefined;
      const top = params.stackTrace?.callFrames?.[0];
      const rec: ConsoleRecord = {
        seq: nextSeq++,
        timestampMs: Date.now(),
        level,
        text,
        source: "console-api",
        ...(top?.url !== undefined && top.url !== "" ? { url: top.url } : {}),
        ...(top?.lineNumber !== undefined ? { lineNumber: top.lineNumber + 1 } : {}),
        ...(stack !== undefined ? { stackTrace: stack } : {}),
      };
      insert(rec);
    },

    ingestLogEntry(p) {
      const decoded = decodeEvent("Log.entryAdded", p);
      const entry = decoded.success ? decoded.data.entry : undefined;
      if (!entry) return;
      const level = mapLogEntryLevel(entry.level);
      const text = truncateArg(entry.text ?? "");
      const stack = level === "error" || level === "warn" ? formatStackTrace(entry.stackTrace) : undefined;
      const rec: ConsoleRecord = {
        seq: nextSeq++,
        timestampMs: Date.now(),
        level,
        text,
        source: "log-entry",
        ...(entry.url !== undefined && entry.url !== "" ? { url: entry.url } : {}),
        ...(entry.lineNumber !== undefined ? { lineNumber: entry.lineNumber + 1 } : {}),
        ...(stack !== undefined ? { stackTrace: stack } : {}),
      };
      insert(rec);
    },

    drain(filter) {
      const matchText = filter.textPattern !== undefined ? compileTextMatcher(filter.textPattern) : undefined;
      const levels = filter.levels && filter.levels.length > 0 ? new Set(filter.levels) : undefined;
      const cutoff = filter.sinceMs !== undefined ? Date.now() - filter.sinceMs : undefined;
      const sinceSeq = filter.sinceSeq;

      const matched: ConsoleRecord[] = [];
      for (const r of records.values()) {
        if (sinceSeq !== undefined && r.seq <= sinceSeq) continue;
        if (levels && !levels.has(r.level)) continue;
        if (cutoff !== undefined && r.timestampMs < cutoff) continue;
        if (matchText && !matchText(r.text)) continue;
        matched.push({ ...r });
      }

      return records.page(matched, filter.limit);
    },

    clear() {
      records.clear();
      nextSeq = 1;
    },
  };
};
