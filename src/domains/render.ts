import { Type } from "typebox";
import { Markdown } from "@mariozechner/pi-tui";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import type { DetailsOf } from "../util/tool";

const COMPACT_PREVIEW_LINES = 6;

// A tool whose details embed this under `render` gets a compact/expanded text view for free.
export const ExpandableTextSchema = Type.Object({
  summary: Type.String(),
  body: Type.String(),
  fullOutputPath: Type.Optional(Type.String()),
});

export type ExpandableText = DetailsOf<typeof ExpandableTextSchema>;

export const renderExpandableText = (render: ExpandableText, expanded: boolean): Component => {
  if (!expanded) {
    const lines = render.body.split("\n");
    const preview = lines.slice(0, COMPACT_PREVIEW_LINES).join("\n");
    const more = lines.length > COMPACT_PREVIEW_LINES ? `\n… ${lines.length - COMPACT_PREVIEW_LINES} more lines` : "";
    const md = `**${render.summary}**\n\n${preview}${more}\n\n${keyHint("app.tools.expand", "to expand")}`;
    return new Markdown(md, 0, 0, getMarkdownTheme());
  }

  const tail = render.fullOutputPath !== undefined
    ? `\n\nFull output at \`${render.fullOutputPath}\` · ${keyHint("app.tools.expand", "to collapse")}`
    : `\n\n${keyHint("app.tools.expand", "to collapse")}`;
  const md = `**${render.summary}**\n\n${render.body}${tail}`;
  return new Markdown(md, 0, 0, getMarkdownTheme());
};
