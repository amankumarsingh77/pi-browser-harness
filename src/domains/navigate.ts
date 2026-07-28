import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { applyTruncation } from "../util/truncate";
import { safeJs } from "../util/js-template";
import { attachTo } from "../cdp/attach";
import { ensureHarnessWindow, openHarnessTab } from "../cdp/target-factory";
import { cdpCall, cdpCallBrowser, cdpCallOnTarget, evalJs } from "./cdp-call";

const NavigateArgs = Type.Object({
  url: Type.String({ description: "Full URL to navigate to (e.g. https://github.com)" }),
});

export type NavOutcome =
  | { readonly kind: "in_place"; readonly targetId: string }
  | { readonly kind: "new_tab_created"; readonly targetId: string; readonly reason: "no_tabs" };

export const navigateTool = defineBrowserTool({
  name: "browser_navigate",
  label: "Browser Navigate",
  description:
    "Navigate to a URL. Creates a new tab on first call (when no real tabs exist). Otherwise navigates the current tab in place.",
  promptSnippet: "Navigate to a URL",
  promptGuidelines: [
    "Use browser_navigate to go to URLs.",
    "Use browser_wait_for_load after browser_navigate to wait for the page to finish loading.",
    "For extracting data from a page you already navigated to, use browser_execute_js or browser_http_get (faster for APIs).",
    "Note: Google and some sites with strict anti-bot detection may reject CDP navigation. Use browser_http_get for search results.",
  ],
  parameters: NavigateArgs,
  concurrency: "serialized",
  renderCall: (a) => new Text(`🌐 Navigate to ${a.url}`, 0, 0),
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const tabs = await client.listTabs(false);
    if (!tabs.success) return err({ kind: "cdp_error", message: tabs.error.message });
    let outcome: NavOutcome;
    if (tabs.data.length === 0) {
      const created = await client.newTab(args.url);
      if (!created.success) return err({ kind: "cdp_error", message: created.error.message });
      outcome = { kind: "new_tab_created", targetId: created.data, reason: "no_tabs" };
    } else {
      const nav = await cdpCall(client, "Page.navigate", { url: args.url });
      if (!nav.success) return nav;
      const cur = client.current();
      if (!cur) return err({ kind: "internal", message: "navigate succeeded but no current target tracked" });
      outcome = { kind: "in_place", targetId: cur.targetId };
    }
    const info = await client.pageInfo();
    if (!info.success) return err({ kind: "cdp_error", message: info.error.message });
    if ("dialog" in info.data) {
      return ok({
        text: `Navigated to ${args.url}\nTarget: ${outcome.targetId}\n⚠️  Dialog open: ${info.data.dialog.type} — "${info.data.dialog.message}"\nUse browser_handle_dialog.`,
        details: { outcome, dialog: info.data.dialog },
      });
    }
    const prefix = outcome.kind === "new_tab_created" ? "New tab: " : "";
    return ok({
      text: `${prefix}Navigated to: ${info.data.url}\nTitle: ${info.data.title}\nViewport: ${info.data.width}x${info.data.height}\nTarget: ${outcome.targetId}`,
      details: { outcome, page: info.data },
    });
  },
});

const OpenUrlsArgs = Type.Object({
  urls: Type.Array(Type.String(), { description: "Array of URLs to open in new tabs" }),
});

type TabResult = {
  readonly url: string;
  readonly targetId: string;
  readonly ok: boolean;
  readonly error?: string;
};

export const openUrlsTool = defineBrowserTool({
  name: "browser_open_urls",
  label: "Browser Open URLs",
  description: "Open multiple URLs in parallel new tabs. Returns per-URL outcomes.",
  promptSnippet: "Open multiple URLs in new tabs (parallel)",
  promptGuidelines: [
    "Use after browser_web_search to open citations in parallel.",
    "After opening, use browser_list_tabs / browser_switch_tab to navigate, then browser_snapshot to inspect each tab.",
    "Use browser_wait_for_load on a tab before extracting data from SPAs.",
  ],
  parameters: OpenUrlsArgs,
  concurrency: "serialized",
  renderCall: (a) => new Text(`🌐 Opening ${a.urls.length} URL${a.urls.length !== 1 ? "s" : ""}…`, 0, 0),
  async handler(args, { client, onUpdate }): Promise<Result<ToolOk, ToolErr>> {
    const total = args.urls.length;
    // All tabs must land in ONE window: a parallel newWindow:true per url would scatter them across N windows, so the first url creates the window and the rest open as its children.
    const url0 = args.urls[0];
    if (url0 === undefined) return err({ kind: "invalid_state", message: "no URLs provided" });
    const window = await ensureHarnessWindow(client);
    if (!window.success) return err({ kind: "cdp_error", message: window.error.message });
    const seededWindow = window.data.targetId;
    const seedResult: TabResult | undefined = window.data.freshlyCreated
      ? { url: url0, targetId: seededWindow, ok: true }
      : undefined;
    const created = await Promise.all(args.urls.map(async (url, i): Promise<TabResult> => {
      if (i === 0 && seedResult) return seedResult;
      const r = await openHarnessTab(client, seededWindow);
      if (!r.success) return { url, targetId: "", ok: false, error: r.error.message };
      return { url, targetId: r.data, ok: true };
    }));
    let completed = 0;
    const settled = await Promise.all(
      created.filter((t) => t.ok).map(async (tab): Promise<TabResult> => {
        try {
          const attached = await attachTo(client.session(), tab.targetId);
          if (!attached.success) return { ...tab, ok: false, error: attached.error.message };
          const sid = attached.data;
          const enabled = await cdpCallOnTarget(client, "Page.enable", {}, sid);
          if (!enabled.success) return { ...tab, ok: false, error: enabled.error.message };
          const nav = await cdpCallOnTarget(client, "Page.navigate", { url: tab.url }, sid);
          if (!nav.success) return { ...tab, ok: false, error: nav.error.message };
          evalJs(
            client,
            safeJs`if(!document.title.startsWith('🟢'))document.title='🟢 '+document.title`,
            sid
          ).catch(() => {});
          return tab;
        } finally {
          completed++;
          // onUpdate must never escape: a renderer crash would otherwise tear down the tool call.
          try {
            onUpdate({ text: `Opening URLs… ${completed}/${created.filter((t) => t.ok).length} navigated` });
          } catch {}
        }
      }),
    );
    const failures = created.filter((t) => !t.ok);
    const all: ReadonlyArray<TabResult> = [...settled, ...failures];
    const okTabs = all.filter((r) => r.ok);
    const failTabs = all.filter((r) => !r.ok);
    if (okTabs.length > 0) {
      const last = okTabs[okTabs.length - 1];
      if (last) {
        await cdpCallBrowser(client, "Target.activateTarget", { targetId: last.targetId });
      }
    }
    const lines: string[] = [];
    if (okTabs.length) {
      lines.push(`✅ ${okTabs.length}/${total} tabs opened:`, ...okTabs.map((t, i) => `  [${i}] ${t.url} → ${t.targetId}`));
    }
    if (failTabs.length) {
      lines.push(`❌ ${failTabs.length}/${total} failed:`, ...failTabs.map((t) => `  ${t.url}: ${t.error ?? "unknown"}`));
    }
    const truncated = await applyTruncation(lines.join("\n"), "urls");
    if (okTabs.length === 0) {
      return err({
        kind: "cdp_error",
        message: `All ${total} URLs failed`,
        ...(truncated.fullOutputPath ? { details: { tabs: all, fullOutputPath: truncated.fullOutputPath } } : { details: { tabs: all } }),
      });
    }
    return ok({
      text: truncated.text,
      ...(truncated.fullOutputPath ? { details: { tabs: all, fullOutputPath: truncated.fullOutputPath } } : { details: { tabs: all } }),
    });
  },
});
