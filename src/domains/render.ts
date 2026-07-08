/**
 * Shared TUI renderer for text-heavy tool output (browser_web_search,
 * browser_read_page). Gives the native pi expand/collapse (Ctrl+O) behavior:
 * a compact preview by default, the full body when expanded — mirroring the
 * pattern in browser_execute_js (src/domains/js.ts:81-109).
 *
 * The full text always goes to the LLM via ToolOk.text; this only governs the
 * human-facing TUI view.
 */
import { Markdown, Text } from "@mariozechner/pi-tui";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";

const COMPACT_PREVIEW_LINES = 6;

/** Structured payload a text-heavy tool stores so renderResult can rebuild views. */
export type ExpandableText = {
  /** One-line summary shown above the body in both states (e.g. "5 results · google"). */
  readonly summary: string;
  /** The full rendered body (markdown/plain). */
  readonly body: string;
  /** Path to the on-disk full output when the LLM text was truncated, if any. */
  readonly fullOutputPath?: string;
};

const isExpandableText = (value: unknown): value is ExpandableText => {
  if (typeof value !== "object" || value === null) return false;
  const v = value as Record<string, unknown>;
  return typeof v["summary"] === "string" && typeof v["body"] === "string";
};

const extractRender = (details: unknown): unknown => {
  if (typeof details !== "object" || details === null) return undefined;
  return (details as Record<string, unknown>)["render"];
};

/**
 * Build a renderResult over an ExpandableText stored in `details.render`.
 * `label` names the tool for the error fallback (e.g. "web_search").
 */
export const renderExpandableText = (
  label: string,
  result: { readonly details?: unknown },
  expanded: boolean,
  theme: Theme,
): Component => {
  const render = extractRender(result.details);
  if (!isExpandableText(render)) return new Text(theme.fg("error", `${label}: no details`), 0, 0);

  if (!expanded) {
    const lines = render.body.split("\n");
    const preview = lines.slice(0, COMPACT_PREVIEW_LINES).join("\n");
    const more = lines.length > COMPACT_PREVIEW_LINES ? `\n… ${lines.length - COMPACT_PREVIEW_LINES} more lines` : "";
    const md = `**${render.summary}**\n\n${preview}${more}\n\n${keyHint("app.tools.expand", "to expand")}`;
    return new Markdown(md, 0, 0, getMarkdownTheme());
  }

  const tail = render.fullOutputPath
    ? `\n\nFull output at \`${render.fullOutputPath}\` · ${keyHint("app.tools.expand", "to collapse")}`
    : `\n\n${keyHint("app.tools.expand", "to collapse")}`;
  const md = `**${render.summary}**\n\n${render.body}${tail}`;
  return new Markdown(md, 0, 0, getMarkdownTheme());
};
