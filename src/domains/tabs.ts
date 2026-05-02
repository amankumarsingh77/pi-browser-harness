import { Type } from "typebox";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";

const ListTabsArgs = Type.Object({
  includeInternal: Type.Optional(Type.Boolean({ default: true, description: "Include chrome:// pages" })),
});

export const listTabsTool = defineBrowserTool({
  name: "browser_list_tabs",
  label: "Browser List Tabs",
  description: "List all open browser tabs (page targets).",
  promptSnippet: "List browser tabs",
  promptGuidelines: [
    "Use to find a targetId for browser_switch_tab.",
    "Internal tabs (chrome://) included by default; pass includeInternal=false to exclude them.",
  ],
  parameters: ListTabsArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await client.listTabs(args.includeInternal ?? true);
    if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
    const lines = r.data.map((t, i) => `  [${i}] ${t.targetId.slice(0, 8)}… ${t.url}\n      ${t.title}`);
    return ok({
      text: `Tabs (${r.data.length}):\n${lines.join("\n")}`,
      details: { tabs: r.data },
    });
  },
});

export const currentTabTool = defineBrowserTool({
  name: "browser_current_tab",
  label: "Browser Current Tab",
  description: "Get info about the currently attached tab.",
  promptSnippet: "Get current tab info",
  promptGuidelines: ["Returns targetId, url, title."],
  parameters: Type.Object({}),
  async handler(_a, { client }): Promise<Result<ToolOk, ToolErr>> {
    const cur = client.current();
    if (!cur) return err({ kind: "invalid_state", message: "No tab attached." });
    const ti = await client.session().callBrowser("Target.getTargetInfo", { targetId: cur.targetId });
    if (!ti.success) return err({ kind: "cdp_error", message: ti.error.message });
    const info = (ti.data as { targetInfo: { targetId: string; url: string; title: string } }).targetInfo; // CDP boundary cast: Target.getTargetInfo returns { targetInfo: { targetId, url, title } }
    return ok({
      text: `Current tab:\n  ${info.targetId}\n  ${info.url}\n  ${info.title}`,
      details: { targetId: info.targetId, url: info.url, title: info.title },
    });
  },
});

const SwitchTabArgs = Type.Object({
  targetId: Type.String({ description: "Target ID from browser_list_tabs" }),
});

export const switchTabTool = defineBrowserTool({
  name: "browser_switch_tab",
  label: "Browser Switch Tab",
  description: "Switch to and attach to a different tab by targetId.",
  promptSnippet: "Switch tabs",
  promptGuidelines: ["Get a targetId via browser_list_tabs first."],
  parameters: SwitchTabArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await client.switchTab(args.targetId);
    if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
    return ok({ text: `Switched to ${args.targetId}`, details: { targetId: args.targetId } });
  },
});

const NewTabArgs = Type.Object({
  url: Type.Optional(Type.String({ description: "Optional URL to navigate to" })),
});

export const newTabTool = defineBrowserTool({
  name: "browser_new_tab",
  label: "Browser New Tab",
  description: "Open a new tab and switch to it. Optionally navigate to a URL.",
  promptSnippet: "Open a new tab",
  promptGuidelines: ["Pass url to navigate immediately."],
  parameters: NewTabArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await client.newTab(args.url);
    if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
    return ok({
      text: `New tab: ${r.data}${args.url ? ` (${args.url})` : ""}`,
      details: args.url !== undefined
        ? { targetId: r.data, url: args.url }
        : { targetId: r.data },
    });
  },
});
