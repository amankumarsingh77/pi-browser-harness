import { Type } from "typebox";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";

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
    "Defaults to scope:'owned' — only tabs this session created. Pass scope:'all' to inspect the user's other tabs.",
    "browser_switch_tab and browser_close_tab refuse non-owned tabs; use browser_new_tab to open one this session controls.",
    "Each tab shows its full 32-char hex targetId — use the exact value with browser_switch_tab.",
    "Internal tabs (chrome://) included by default; pass includeInternal=false to exclude them.",
  ],
  parameters: ListTabsArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await client.listTabs(args.includeInternal ?? true);
    if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
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
  async handler(_a, { client }): Promise<Result<ToolOk, ToolErr>> {
    const cur = client.current();
    if (!cur) return err({ kind: "invalid_state", message: "No tab attached." });
    const ti = await client.session().callBrowser("Target.getTargetInfo", { targetId: cur.targetId });
    if (!ti.success) return err({ kind: "cdp_error", message: ti.error.message });
    const info = (ti.data as { targetInfo: { targetId: string; url: string; title: string } }).targetInfo; // CDP boundary cast: Target.getTargetInfo returns { targetInfo: { targetId, url, title } }
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

const ownershipDeniedMessage = (id: string, namespace: string): string =>
  `Tab ${id} is not owned by this harness session (namespace: ${namespace}). ` +
  `Use browser_list_tabs with scope:'all' to see it, or browser_new_tab to open one this session can control.`;

export const switchTabTool = defineBrowserTool({
  name: "browser_switch_tab",
  label: "Browser Switch Tab",
  description: "Switch to and attach to a different tab by targetId. Only tabs this harness session opened are accepted.",
  promptSnippet: "Switch tabs",
  promptGuidelines: [
    "Get a targetId via browser_list_tabs first.",
    "Accepts exact targetId or a unique prefix of at least 8 hex characters.",
    "Refuses tabs not owned by this session — use browser_new_tab to open a controllable tab instead.",
  ],
  parameters: SwitchTabArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    // Resolve to a concrete targetId (exact, or unique hex prefix). We resolve
    // first so the ownership check sees the canonical id, not the prefix.
    let resolved = args.targetId;
    if (!client.owns(resolved)) {
      const isHexPrefix = /^[0-9A-Fa-f]{8,}$/.test(args.targetId);
      if (isHexPrefix) {
        const tabs = await client.listTabs(true);
        if (!tabs.success) return err({ kind: "cdp_error", message: tabs.error.message });
        const matches = tabs.data.filter((t) => t.targetId.startsWith(args.targetId));
        if (matches.length === 0) {
          return err({ kind: "cdp_error", message: `No tab found with prefix "${args.targetId}"` });
        }
        if (matches.length > 1) {
          const ids = matches.map((t) => t.targetId).join(", ");
          return err({
            kind: "invalid_state",
            message: `Ambiguous prefix "${args.targetId}" matches ${matches.length} tabs: ${ids}`,
            details: { matches: matches.map((t) => ({ targetId: t.targetId, url: t.url })) },
          });
        }
        resolved = matches[0]!.targetId;
      }
      if (!client.owns(resolved)) {
        return err({
          kind: "invalid_state",
          message: ownershipDeniedMessage(resolved, client.namespace),
          details: { targetId: resolved, namespace: client.namespace },
        });
      }
    }

    const r = await client.switchTab(resolved);
    if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
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
  promptGuidelines: [
    "All tabs opened by this tool live in a single dedicated Chrome window separate from the user's main browsing.",
    "Pass url to navigate immediately.",
  ],
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

const CloseTabArgs = Type.Object({
  targetId: Type.String({ description: "Target ID from browser_list_tabs" }),
});

export const closeTabTool = defineBrowserTool({
  name: "browser_close_tab",
  label: "Browser Close Tab",
  description: "Close a tab the harness owns. Refuses tabs not opened by this session.",
  promptSnippet: "Close an owned tab",
  promptGuidelines: [
    "Only closes tabs this session opened (visible in browser_list_tabs default scope).",
    "Accepts exact targetId or a unique hex prefix (>=8 chars).",
  ],
  parameters: CloseTabArgs,
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    let resolved = args.targetId;
    if (!client.owns(resolved)) {
      const isHexPrefix = /^[0-9A-Fa-f]{8,}$/.test(args.targetId);
      if (isHexPrefix) {
        const owned = client.ownership().list();
        const matches = owned.filter((id) => id.startsWith(args.targetId));
        if (matches.length === 1) resolved = matches[0]!;
        else if (matches.length > 1) {
          return err({
            kind: "invalid_state",
            message: `Ambiguous prefix "${args.targetId}" matches ${matches.length} owned tabs: ${matches.join(", ")}`,
          });
        }
      }
      if (!client.owns(resolved)) {
        return err({
          kind: "invalid_state",
          message: ownershipDeniedMessage(resolved, client.namespace),
          details: { targetId: resolved, namespace: client.namespace },
        });
      }
    }
    const r = await client.closeTab(resolved);
    if (!r.success) return err({ kind: "cdp_error", message: r.error.message });
    return ok({ text: `Closed tab ${resolved}`, details: { targetId: resolved } });
  },
});
