import { Type } from "typebox";
import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";

type HistoryEntry = { readonly id: number; readonly url: string; readonly title: string };
type History = { readonly entries: ReadonlyArray<HistoryEntry>; readonly currentIndex: number };

const fetchHistory = async (client: BrowserClient): Promise<Result<History, ToolErr>> => {
  const r = await client.session().call("Page.getNavigationHistory");
  if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
  return ok(r.data as History);
};

export const goBackTool = defineBrowserTool({
  name: "browser_go_back",
  label: "Browser Go Back",
  description: "Navigate back one page in history.",
  promptSnippet: "Go back one page",
  promptGuidelines: ["Use to return to the previous page after navigating."],
  parameters: Type.Object({}),
  async handler(_a, { client }): Promise<Result<ToolOk, ToolErr>> {
    const h = await fetchHistory(client);
    if (!h.success) return h;
    if (h.data.currentIndex <= 0) return ok({ text: "Already at the beginning of history." });
    const target = h.data.entries[h.data.currentIndex - 1];
    if (!target) return err({ kind: "internal", message: "history entry missing at index" });
    const nav = await client.session().call("Page.navigateToHistoryEntry", { entryId: target.id });
    if (!nav.success) return err({ kind: "cdp_error", message: nav.error.message });
    return ok({ text: `Navigated back to: ${target.url}`, details: { url: target.url } });
  },
});

export const goForwardTool = defineBrowserTool({
  name: "browser_go_forward",
  label: "Browser Go Forward",
  description: "Navigate forward one page in history.",
  promptSnippet: "Go forward one page",
  promptGuidelines: ["Use to undo a browser_go_back."],
  parameters: Type.Object({}),
  async handler(_a, { client }): Promise<Result<ToolOk, ToolErr>> {
    const h = await fetchHistory(client);
    if (!h.success) return h;
    if (h.data.currentIndex >= h.data.entries.length - 1) return ok({ text: "Already at the end of history." });
    const target = h.data.entries[h.data.currentIndex + 1];
    if (!target) return err({ kind: "internal", message: "history entry missing at index" });
    const nav = await client.session().call("Page.navigateToHistoryEntry", { entryId: target.id });
    if (!nav.success) return err({ kind: "cdp_error", message: nav.error.message });
    return ok({ text: `Navigated forward to: ${target.url}`, details: { url: target.url } });
  },
});

export const reloadTool = defineBrowserTool({
  name: "browser_reload",
  label: "Browser Reload",
  description: "Reload the current page.",
  promptSnippet: "Reload the page",
  promptGuidelines: ["Use to refresh the page, e.g. after server-side changes."],
  parameters: Type.Object({}),
  async handler(_a, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await client.session().call("Page.reload");
    if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
    const info = await client.pageInfo();
    if (!info.success) return err({ kind: "cdp_error", message: info.error.message });
    if ("dialog" in info.data) {
      return ok({
        text: `Reloaded. ⚠️ Dialog open: ${info.data.dialog.type}`,
        details: { dialog: info.data.dialog },
      });
    }
    return ok({
      text: `Reloaded: ${info.data.title} (${info.data.url})`,
      details: { page: info.data },
    });
  },
});
