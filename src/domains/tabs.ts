import { Type } from "typebox";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { cdpCallBrowser, fromClient } from "./cdp-call";
import { resolveOwnedTargetId } from "./tab-resolve";

const ListTabsArgs = Type.Object({
  includeInternal: Type.Optional(Type.Boolean({ default: true, description: "Include chrome:// pages" })),
  scope: Type.Optional(
    Type.Union([Type.Literal("owned"), Type.Literal("all")], {
      default: "owned",
      description: "'owned' (default) shows only tabs this harness session opened; 'all' shows every tab in the browser.",
    }),
  ),
});

export const listTabsTool = defineBrowserTool({
  name: "browser_list_tabs",
  label: "Browser List Tabs",
  description: "List browser tabs. Defaults to tabs this harness session opened (scope:'owned'). Pass scope:'all' to see the user's other tabs too.",
  promptSnippet: "List browser tabs",
  promptGuidelines: [
    "Each tab shows its full 32-char hex targetId — use the exact value with browser_switch_tab.",
  ],
  parameters: ListTabsArgs,
  concurrency: "parallel",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = fromClient(await client.listTabs(args.includeInternal ?? true), "Target.getTargets");
    if (!r.success) return r;
    const scope = args.scope ?? "owned";
    const filtered = scope === "owned" ? r.data.filter((t) => t.owned) : r.data;
    const lines = filtered.map((t, i) => {
      const flag = t.owned ? "★" : " ";
      return `  ${flag} [${i}] ${t.targetId} ${t.url}\n      ${t.title}`;
    });
    const header = scope === "owned"
      ? `Owned tabs (${filtered.length}):`
      : `All tabs (${filtered.length}, ★ = owned by this session):`;
    return ok({
      text: `${header}\n${lines.join("\n")}`,
      details: { tabs: filtered, scope },
    });
  },
});

export const currentTabTool = defineBrowserTool({
  name: "browser_current_tab",
  label: "Browser Current Tab",
  description: "Get info about the currently attached tab.",
  promptSnippet: "Get current tab info",
  promptGuidelines: ["Returns targetId, url, title, and whether the tab is owned by this harness session."],
  parameters: Type.Object({}),
  concurrency: "parallel",
  async handler(_a, { client }): Promise<Result<ToolOk, ToolErr>> {
    const cur = client.current();
    if (!cur) return err({ kind: "invalid_state", message: "No tab attached." });
    const ti = await cdpCallBrowser(client, "Target.getTargetInfo", { targetId: cur.targetId });
    if (!ti.success) return ti;
    const info = ti.data.targetInfo;
    const owned = client.owns(info.targetId);
    return ok({
      text: `Current tab${owned ? " (owned)" : " (NOT owned by this session)"}:\n  ${info.targetId}\n  ${info.url}\n  ${info.title}`,
      details: { targetId: info.targetId, url: info.url, title: info.title, owned },
    });
  },
});

const SwitchTabArgs = Type.Object({
  targetId: Type.String({ description: "Target ID from browser_list_tabs" }),
});

export const switchTabTool = defineBrowserTool({
  name: "browser_switch_tab",
  label: "Browser Switch Tab",
  description: "Switch to and attach to a different tab by targetId. Only tabs this harness session opened are accepted.",
  promptSnippet: "Switch tabs",
  promptGuidelines: [
    "Get a targetId via browser_list_tabs first.",
    "Accepts exact targetId or a unique prefix (>=8 hex characters) of an owned tab.",
  ],
  parameters: SwitchTabArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const target = resolveOwnedTargetId(client, args.targetId);
    if (!target.success) return target;
    const resolved = target.data;
    const r = fromClient(await client.switchTab(resolved), "Target.attachToTarget");
    if (!r.success) return r;
    const note = resolved === args.targetId ? "" : ` (resolved from prefix "${args.targetId}")`;
    return ok({
      text: `Switched to ${resolved}${note}`,
      details: { targetId: resolved },
    });
  },
});

const NewTabArgs = Type.Object({
  url: Type.Optional(Type.String({ description: "Optional URL to navigate to" })),
});

export const newTabTool = defineBrowserTool({
  name: "browser_new_tab",
  label: "Browser New Tab",
  description: "Open a new tab in the harness's dedicated Chrome window and switch to it. Optionally navigate to a URL.",
  promptSnippet: "Open a new tab",
  promptGuidelines: [],
  parameters: NewTabArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = fromClient(await client.newTab(args.url), "Target.createTarget");
    if (!r.success) return r;
    return ok({
      text: `New tab: ${r.data}${args.url ? ` (${args.url})` : ""}`,
      details: args.url !== undefined
        ? { targetId: r.data, url: args.url }
        : { targetId: r.data },
    });
  },
});

const CloseTabArgs = Type.Object({
  targetId: Type.String({ description: "Target ID from browser_list_tabs" }),
});

export const closeTabTool = defineBrowserTool({
  name: "browser_close_tab",
  label: "Browser Close Tab",
  description: "Close a tab the harness owns. Refuses tabs not opened by this session.",
  promptSnippet: "Close an owned tab",
  promptGuidelines: [
    "Same targetId rules as browser_switch_tab: exact id or a unique prefix (>=8 hex) of an owned tab.",
  ],
  parameters: CloseTabArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const target = resolveOwnedTargetId(client, args.targetId);
    if (!target.success) return target;
    const resolved = target.data;
    const r = fromClient(await client.closeTab(resolved), "Target.closeTarget");
    if (!r.success) return r;
    return ok({ text: `Closed tab ${resolved}`, details: { targetId: resolved } });
  },
});
