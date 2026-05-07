/**
 * In-memory aggregator for CDP Runtime.consoleAPICalled and Log.entryAdded events.
 *
 * Mirrors network-buffer.ts: the single CDP event loop in session.ts hands raw
 * params to ingestConsoleApi / ingestLogEntry; tools later read records via drain().
 *
 * Bounded by capacity (default 500). On overflow the oldest record is evicted FIFO,
 * and the overflow flag is reported once per drain so tools can warn the LLM that
 * data may be missing.
 *
 * Each record carries a monotonic `seq`. Tools expose the last drained seq as
 * `nextCursor`; callers pass it back as `sinceSeq` to read only what's new since
 * the previous drain. This is the cursor pattern that makes "what did this action
 * cause?" answerable in one tool call.
 *
 * Pure module (no CDP dependency) — joining/filtering logic stays trivially testable.
 */

export type ConsoleLevel = "log" | "info" | "warn" | "error" | "debug";

export type ConsoleRecord = {
  seq: number;
  /** Wall-clock ms when the event was ingested, in Date.now() units. */
  timestampMs: number;
  level: ConsoleLevel;
  /** Joined args (console-api) or the entry text (log-entry). Per-arg truncated. */
  text: string;
  source: "console-api" | "log-entry";
  url?: string;
  lineNumber?: number;
  /** Top frames only, joined with newlines. Populated for error/warn when CDP provides one. */
  stackTrace?: string;
};

export type ConsoleFilter = {
  levels?: ConsoleLevel[];
  /** Substring match by default. Wrap in slashes (`/foo/`) for regex. */
  textPattern?: string;
  /** Only records with seq strictly greater than this. */
  sinceSeq?: number;
  /** Only records with timestamp at most N ms ago. */
  sinceMs?: number;
  /** Cap on returned records (default 50, max 500). */
  limit?: number;
};

export type ConsoleDrainResult = {
  readonly records: ConsoleRecord[];
  /** Total matches before `limit` was applied. */
  readonly total: number;
  /** True if the ring buffer evicted at least one record since the last drain. */
  readonly bufferOverflowed: boolean;
};

export type ConsoleBuffer = {
  ingestConsoleApi(p: unknown): void;
  ingestLogEntry(p: unknown): void;
  drain(filter: ConsoleFilter): ConsoleDrainResult;
  clear(): void;
};

/** Per-arg cap to stop a single console.log(hugeBlob) from blowing the buffer. */
const PER_ARG_CAP = 2000;
/** Max stack frames preserved per record. */
const MAX_STACK_FRAMES = 3;

const compileTextMatcher = (pattern: string): ((text: string) => boolean) => {
  if (pattern.length >= 2 && pattern.startsWith("/") && pattern.endsWith("/")) {
    try {
      const re = new RegExp(pattern.slice(1, -1));
      return (text) => re.test(text);
    } catch {
      // Fall through to substring match if the pattern is not a valid regex.
    }
  }
  return (text) => text.includes(pattern);
};

const truncateArg = (s: string): string =>
  s.length > PER_ARG_CAP ? s.slice(0, PER_ARG_CAP) + "…" : s;

/** Best-effort stringification of one Runtime.RemoteObject. */
const stringifyRemoteObject = (
  arg: { type?: string; subtype?: string; value?: unknown; description?: string; unserializableValue?: string },
): string => {
  if (arg.unserializableValue !== undefined) return arg.unserializableValue;
  if (arg.value !== undefined) {
    if (typeof arg.value === "string") return arg.value;
    try {
      return JSON.stringify(arg.value);
    } catch {
      return String(arg.value);
    }
  }
  if (arg.description !== undefined) return arg.description;
  return arg.type ?? "";
};

/** Map CDP console-API method names to our normalized levels. */
const mapConsoleApiLevel = (type: string | undefined): ConsoleLevel => {
  switch (type) {
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

/** Map Log.LogEntry.level values ("verbose","info","warning","error") to our levels. */
const mapLogEntryLevel = (level: string | undefined): ConsoleLevel => {
  switch (level) {
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
  // Insertion-ordered map keyed by seq. Map preserves insertion order in JS,
  // so iteration gives us oldest-first eviction without a separate index.
  const records = new Map<number, ConsoleRecord>();
  let nextSeq = 1;
  let overflowed = false;

  const evictOldestIfFull = (): void => {
    while (records.size >= capacity) {
      const oldest = records.keys().next();
      if (oldest.done) return;
      records.delete(oldest.value);
      overflowed = true;
    }
  };

  const insert = (rec: ConsoleRecord): void => {
    evictOldestIfFull();
    records.set(rec.seq, rec);
  };

  return {
    ingestConsoleApi(p) {
      // CDP boundary cast: Runtime.consoleAPICalled
      const params = p as
        | {
            type?: string;
            args?: ReadonlyArray<{
              type?: string;
              subtype?: string;
              value?: unknown;
              description?: string;
              unserializableValue?: string;
            }>;
            stackTrace?: { callFrames?: ReadonlyArray<{ url?: string; lineNumber?: number; functionName?: string }> };
          }
        | undefined;
      if (!params) return;
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
      // CDP boundary cast: Log.entryAdded
      const params = p as
        | {
            entry?: {
              level?: string;
              text?: string;
              url?: string;
              lineNumber?: number;
              stackTrace?: { callFrames?: ReadonlyArray<{ url?: string; lineNumber?: number; functionName?: string }> };
            };
          }
        | undefined;
      const entry = params?.entry;
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

      const total = matched.length;
      const limit = Math.min(filter.limit ?? 50, 500);
      const limited = matched.slice(-limit);

      const bufferOverflowed = overflowed;
      overflowed = false;

      return { records: limited, total, bufferOverflowed };
    },

    clear() {
      records.clear();
      overflowed = false;
      // nextSeq is intentionally NOT reset: the cursor remains monotonic across
      // tab switches so a stale sinceSeq from a previous tab can't accidentally
      // match new records.
    },
  };
};
