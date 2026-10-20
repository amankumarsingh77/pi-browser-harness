import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { applyTruncation } from "../util/truncate";
import { safeJs } from "../util/js-template";
import { borrowSession, ensureHarnessWindow, openHarnessTab } from "../cdp/target-factory";
import { cdpCall, cdpCallBrowser, cdpCallOnTarget, evalJs, fromClient } from "./cdp-call";
import { pollUntil, READY_STATE_COMPLETE } from "./poll";

const NavigateArgs = Type.Object({
  url: Type.String({ description: "Full URL to navigate to (e.g. https://github.com)" }),
});

type NavOutcome =
  | { readonly kind: "in_place"; readonly targetId: string }
  | { readonly kind: "new_tab_created"; readonly targetId: string; readonly reason: "no_tabs" };

export const navigateTool = defineBrowserTool({
  name: "browser_navigate",
  label: "Browser Navigate",
  description:
    "Navigate to a URL. Creates a new tab on first call (when no real tabs exist). Otherwise navigates the current tab in place.",
  promptSnippet: "Navigate to a URL",
  promptGuidelines: [
    "For extracting data from a page you already navigated to, use browser_execute_js or browser_http_get (faster for APIs).",
    "Note: Google and some sites with strict anti-bot detection may reject CDP navigation. Use browser_http_get for search results.",
  ],
  parameters: NavigateArgs,
  concurrency: "serialized",
  renderCall: (a) => new Text(`🌐 Navigate to ${a.url}`, 0, 0),
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const tabs = fromClient(await client.listTabs(false), "Target.getTargets");
    if (!tabs.success) return tabs;
    let outcome: NavOutcome;
    if (tabs.data.length === 0) {
      const created = fromClient(await client.newTab(args.url), "Target.createTarget");
      if (!created.success) return created;
      outcome = { kind: "new_tab_created", targetId: created.data, reason: "no_tabs" };
    } else {
      const nav = await cdpCall(client, "Page.navigate", { url: args.url });
      if (!nav.success) return nav;
      const cur = client.current();
      if (!cur) return err({ kind: "internal", message: "navigate succeeded but no current target tracked" });
      outcome = { kind: "in_place", targetId: cur.targetId };
    }
    const info = fromClient(await client.pageInfo(), "pageInfo");
    if (!info.success) return info;
    if (info.data.kind === "dialog") {
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
  readonly note?: string;
};

// The marker is applied once the document has loaded; applying it right after Page.navigate would mark the
// outgoing document and be overwritten by the incoming one.
const TITLE_MARK_TIMEOUT_MS = 10_000;

// Opens one tab per url in a single harness window. All tabs must land in ONE window: a parallel newWindow:true
// per url would scatter them across N windows, so the first url seeds the window and the rest open as its children.
const createTabs = async (client: BrowserClient, urls: ReadonlyArray<string>): Promise<Result<ReadonlyArray<TabResult>, ToolErr>> => {
  const url0 = urls[0];
  if (url0 === undefined) return err({ kind: "invalid_args", message: "no URLs provided" });
  const window = await ensureHarnessWindow(client);
  if (!window.success) return fromClient(window, "Target.createTarget");
  const seededWindow = window.data.targetId;
  const seedResult: TabResult | undefined = window.data.freshlyCreated
    ? { url: url0, targetId: seededWindow, ok: true }
    : undefined;
  const created = await Promise.all(urls.map(async (url, i): Promise<TabResult> => {
    if (i === 0 && seedResult) return seedResult;
    const r = await openHarnessTab(client, seededWindow);
    if (!r.success) return { url, targetId: "", ok: false, error: r.error.message };
    return { url, targetId: r.data, ok: true };
  }));
  return ok(created);
};

// Cosmetic, and polled per tab in parallel: a slow interval keeps N tabs from hammering the daemon socket.
const TITLE_MARK_POLL_MS = 250;

const markTitle = async (client: BrowserClient, sessionId: string, signal: AbortSignal | undefined): Promise<Result<void, ToolErr>> => {
  const loaded = await pollUntil(client, READY_STATE_COMPLETE, { timeoutMs: TITLE_MARK_TIMEOUT_MS, intervalMs: TITLE_MARK_POLL_MS, signal, sessionId, what: "page load" });
  if (!loaded.success) return loaded;
  const marked = await evalJs(client, safeJs`if(!document.title.startsWith('🟢'))document.title='🟢 '+document.title`, sessionId);
  if (!marked.success) return marked;
  return ok(undefined);
};

// Borrows a session on a created tab, navigates it, and marks its title after load. A marker failure is a note, not a failure.
// The borrowed session is released in every path so an untracked attach never leaks past this call.
const navigateTab = async (client: BrowserClient, tab: TabResult, signal: AbortSignal | undefined): Promise<TabResult> => {
  const borrowed = fromClient(await borrowSession(client, tab.targetId), "Target.attachToTarget");
  if (!borrowed.success) return { ...tab, ok: false, error: borrowed.error.message };
  const sid = borrowed.data.sessionId;
  try {
    const enabled = await cdpCallOnTarget(client, "Page.enable", {}, sid);
    if (!enabled.success) return { ...tab, ok: false, error: enabled.error.message };
    const nav = await cdpCallOnTarget(client, "Page.navigate", { url: tab.url }, sid);
    if (!nav.success) return { ...tab, ok: false, error: nav.error.message };
    const marked = await markTitle(client, sid, signal);
    return marked.success ? tab : { ...tab, note: "still loading" };
  } finally {
    await borrowed.data.release();
  }
};

const renderOutcomes = (all: ReadonlyArray<TabResult>, total: number): string => {
  const okTabs = all.filter((r) => r.ok);
  const failTabs = all.filter((r) => !r.ok);
  const lines: string[] = [];
  if (okTabs.length) {
    lines.push(
      `✅ ${okTabs.length}/${total} tabs opened:`,
      ...okTabs.map((t, i) => `  [${i}] ${t.url} → ${t.targetId}${t.note !== undefined ? ` (${t.note})` : ""}`),
    );
  }
  if (failTabs.length) {
    lines.push(`❌ ${failTabs.length}/${total} failed:`, ...failTabs.map((t) => `  ${t.url}: ${t.error ?? "unknown"}`));
  }
  return lines.join("\n");
};

export const openUrlsTool = defineBrowserTool({
  name: "browser_open_urls",
  label: "Browser Open URLs",
  description: "Open multiple URLs in parallel new tabs. Returns per-URL outcomes.",
  promptSnippet: "Open multiple URLs in new tabs (parallel)",
  promptGuidelines: [
    "Use after browser_web_search to open citations in parallel.",
    "After opening, use browser_list_tabs / browser_switch_tab to navigate, then browser_snapshot to inspect each tab.",
  ],
  parameters: OpenUrlsArgs,
  concurrency: "serialized",
  renderCall: (a) => new Text(`🌐 Opening ${a.urls.length} URL${a.urls.length !== 1 ? "s" : ""}…`, 0, 0),
  async handler(args, { client, onUpdate, signal }): Promise<Result<ToolOk, ToolErr>> {
    const total = args.urls.length;
    const created = await createTabs(client, args.urls);
    if (!created.success) return created;
    const toNavigate = created.data.filter((t) => t.ok);
    let completed = 0;
    const settled = await Promise.all(
      toNavigate.map(async (tab): Promise<TabResult> => {
        try {
          return await navigateTab(client, tab, signal);
        } finally {
          completed++;
          // onUpdate must never escape: a renderer crash would otherwise tear down the tool call.
          try {
            onUpdate({ text: `Opening URLs… ${completed}/${toNavigate.length} navigated` });
          } catch {
            // Progress is best-effort; the navigation outcome is what the tool reports.
          }
        }
      }),
    );
    const all: ReadonlyArray<TabResult> = [...settled, ...created.data.filter((t) => !t.ok)];
    const okTabs = all.filter((r) => r.ok);
    const last = okTabs[okTabs.length - 1];
    if (last !== undefined) {
      await cdpCallBrowser(client, "Target.activateTarget", { targetId: last.targetId });
    }
    const truncated = await applyTruncation(renderOutcomes(all, total), "urls");
    const details = {
      tabs: all,
      ...(truncated.fullOutputPath !== undefined ? { fullOutputPath: truncated.fullOutputPath } : {}),
    };
    if (okTabs.length === 0) {
      return err({ kind: "cdp_error", message: `All ${total} URLs failed`, details });
    }
    return ok({ text: truncated.text, details });
  },
});
