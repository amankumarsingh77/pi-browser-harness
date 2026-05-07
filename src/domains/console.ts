import { Type } from "typebox";
import { Markdown, Text } from "@mariozechner/pi-tui";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import { type Result, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { applyTruncation } from "../util/truncate";
import type { ConsoleRecord, ConsoleLevel } from "../cdp/console-buffer";

const ConsoleArgs = Type.Object({
  levels: Type.Optional(
    Type.Array(
      Type.Union(
        [
          Type.Literal("log"),
          Type.Literal("info"),
          Type.Literal("warn"),
          Type.Literal("error"),
          Type.Literal("debug"),
        ],
      ),
      { description: 'Filter to these levels only, e.g. ["error","warn"]. Default: all levels.' },
    ),
  ),
  textPattern: Type.Optional(
    Type.String({ description: "Substring match by default. Wrap in slashes (e.g. /TypeError/) for regex." }),
  ),
  sinceSeq: Type.Optional(
    Type.Integer({ minimum: 0, description: "Only records with seq strictly greater than this. Use the previous call's nextCursor to see only what's new." }),
  ),
  sinceMs: Type.Optional(
    Type.Integer({ minimum: 0, description: "Only records from the last N ms." }),
  ),
  limit: Type.Optional(
    Type.Integer({ default: 50, minimum: 1, maximum: 500, description: "Max records to return." }),
  ),
});

const levelTag = (lvl: ConsoleLevel): string => {
  switch (lvl) {
    case "error": return "[error]";
    case "warn":  return "[warn] ";
    case "info":  return "[info] ";
    case "debug": return "[debug]";
    default:      return "[log]  ";
  }
};

const formatLocation = (r: ConsoleRecord): string => {
  if (r.url === undefined || r.url === "") return "";
  const short = r.url.length > 60 ? "…" + r.url.slice(-59) : r.url;
  return r.lineNumber !== undefined ? `${short}:${r.lineNumber}` : short;
};

const renderConsoleMarkdown = (
  records: ReadonlyArray<ConsoleRecord>,
  opts: { total: number; bufferOverflowed: boolean; expanded: boolean; nextCursor: number | undefined },
): string => {
  if (records.length === 0) {
    if (opts.bufferOverflowed) return "_No matching console records. (Buffer overflowed since last drain — some events were dropped.)_";
    return "_No matching console records captured yet._";
  }

  const counts = records.reduce<Record<ConsoleLevel, number>>(
    (acc, r) => { acc[r.level]++; return acc; },
    { log: 0, info: 0, warn: 0, error: 0, debug: 0 },
  );

  const summaryParts: string[] = [];
  if (counts.error > 0) summaryParts.push(`${counts.error} error${counts.error === 1 ? "" : "s"}`);
  if (counts.warn  > 0) summaryParts.push(`${counts.warn} warning${counts.warn === 1 ? "" : "s"}`);
  if (counts.info  > 0) summaryParts.push(`${counts.info} info`);
  if (counts.log   > 0) summaryParts.push(`${counts.log} log${counts.log === 1 ? "" : "s"}`);
  if (counts.debug > 0) summaryParts.push(`${counts.debug} debug`);

  const headerLines: string[] = [`**${summaryParts.join(" · ")}**`];
  if (opts.bufferOverflowed) headerLines.push("⚠ buffer overflowed since last drain — older entries dropped");
  if (opts.total > records.length) headerLines.push(`(${records.length} of ${opts.total} matches shown — increase \`limit\` for more)`);

  const renderRow = (r: ConsoleRecord, compact: boolean): string => {
    const tag = levelTag(r.level);
    const loc = formatLocation(r);
    const maxText = compact ? 80 : 200;
    const text = r.text.length > maxText ? r.text.slice(0, maxText - 1) + "…" : r.text;
    const locSuffix = loc !== "" ? `  _at ${loc}_` : "";
    const main = `\`${tag}\` ${text}${locSuffix}`;
    if (!compact && r.stackTrace !== undefined) return `${main}\n\`\`\`\n${r.stackTrace}\n\`\`\``;
    return main;
  };

  const visible = !opts.expanded && records.length > 5 ? records.slice(-5) : records;
  const rows = visible.map((r) => renderRow(r, !opts.expanded)).join(opts.expanded ? "\n\n" : "\n");

  const more = !opts.expanded && records.length > 5 ? `\n  … ${records.length - 5} earlier (expand to see all)` : "";
  const cursor = opts.nextCursor !== undefined ? `\n\n_nextCursor=${opts.nextCursor}_` : "";

  return `${headerLines.join("\n")}\n\n${rows}${more}${cursor}`;
};

type ConsoleDetails = {
  total: number;
  returned: number;
  bufferOverflowed: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  records: ReadonlyArray<ConsoleRecord>;
  nextCursor?: number;
};

export const consoleTool = defineBrowserTool({
  name: "browser_console",
  label: "Browser Console",
  description:
    "Read JS errors and console messages from the active tab. Diagnostic — use when an action looks broken or silent.",
  promptSnippet: "Read JS errors / console output on the current tab",
  promptGuidelines: [
    "Use after a click, submit, or navigate produced no visible change — errors often explain it.",
    "Pass `sinceSeq` from the previous call's `nextCursor` to see only new messages after an action.",
    "Buffer is reset on tab switch (capacity 500 records). bufferOverflowed:true means older entries were dropped.",
    "Don't use as a default observation tool — prefer browser_snapshot for page structure.",
  ],
  parameters: ConsoleArgs,

  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const session = client.session();
    const drained = session.drainConsoleBuffer({
      ...(args.levels !== undefined ? { levels: args.levels } : {}),
      ...(args.textPattern !== undefined ? { textPattern: args.textPattern } : {}),
      ...(args.sinceSeq !== undefined ? { sinceSeq: args.sinceSeq } : {}),
      ...(args.sinceMs !== undefined ? { sinceMs: args.sinceMs } : {}),
      limit: args.limit ?? 50,
    });

    const last = drained.records.at(-1);
    const nextCursor = last?.seq;

    const text = renderConsoleMarkdown(drained.records, {
      total: drained.total,
      bufferOverflowed: drained.bufferOverflowed,
      expanded: true, // full text always returned to the LLM; renderResult handles compact view for humans
      nextCursor,
    });
    const trunc = await applyTruncation(text, "console");

    const details: ConsoleDetails = {
      total: drained.total,
      returned: drained.records.length,
      bufferOverflowed: drained.bufferOverflowed,
      truncated: trunc.wasTruncated,
      records: drained.records,
      ...(nextCursor !== undefined ? { nextCursor } : {}),
    };
    if (trunc.fullOutputPath !== undefined) details.fullOutputPath = trunc.fullOutputPath;

    return ok({ text: trunc.text, details });
  },

  renderResult(result, expanded, theme) {
    const details = result.details as ConsoleDetails | undefined;
    if (!details) return new Text(theme.fg("error", "console: no details"), 0, 0);

    const md = renderConsoleMarkdown(details.records, {
      total: details.total,
      bufferOverflowed: details.bufferOverflowed,
      expanded,
      nextCursor: details.nextCursor,
    });
    const tail = expanded
      ? `\n\n${keyHint("app.tools.expand", "to collapse")}${details.fullOutputPath ? ` · full payload at \`${details.fullOutputPath}\`` : ""}`
      : `\n\n${keyHint("app.tools.expand", "to expand")}`;

    return new Markdown(md + tail, 0, 0, getMarkdownTheme());
  },
});
