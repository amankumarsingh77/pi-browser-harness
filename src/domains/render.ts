import { Markdown, Text } from "@mariozechner/pi-tui";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import type { Theme } from "@mariozechner/pi-coding-agent";
import { isRecord } from "../util/guards";

const COMPACT_PREVIEW_LINES = 6;

export type ExpandableText = {
  readonly summary: string;
  readonly body: string;
  readonly fullOutputPath?: string;
};

const isExpandableText = (value: unknown): value is ExpandableText =>
  isRecord(value) && typeof value["summary"] === "string" && typeof value["body"] === "string";

const extractRender = (details: unknown): unknown =>
  isRecord(details) ? details["render"] : undefined;

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
