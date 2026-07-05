import { type Result, err, ok } from "./util/result";
import { safeJs } from "./util/js-template";
import { type Mutex, createMutex } from "./util/mutex";
import { discoverWsUrl } from "./cdp/discovery";
import { type CdpError, cdpError } from "./cdp/errors";
import type { CdpTransport } from "./cdp/transport";
import { createCdpTransport } from "./cdp/transport";
import { type CdpSession, createCdpSession } from "./cdp/session";
import { type OwnershipRegistry, createOwnershipRegistry } from "./cdp/ownership";
import type { DaemonStatus, DialogInfo, PageInfo, TabInfo } from "./cdp/types";

export type BrowserClientOptions = {
  readonly namespace: string;
  readonly transport?: CdpTransport;
  readonly remote?: { readonly cdpUrl: string; readonly browserId: string };
  readonly initialOwnership?: {
    readonly ownedTargetIds?: ReadonlyArray<string>;
    readonly harnessWindowTargetId?: string;
  };
  readonly onOwnershipChange?: (snapshot: {
    readonly ownedTargetIds: ReadonlyArray<string>;
    readonly harnessWindowTargetId: string | undefined;
  }) => void;
};

export type BrowserClient = {
  readonly namespace: string;
  ensureAlive(): Promise<Result<void, CdpError>>;
  status(): DaemonStatus;
  start(): Promise<Result<void, CdpError>>;
  stop(): Promise<void>;
  /** Detach from the current page target (removes the "Chrome is being controlled" banner)
   *  while keeping the transport connection alive. Call on session shutdown. */
  detach(): Promise<void>;
  evaluateJs(expression: string, sessionId?: string): Promise<Result<unknown, CdpError>>;
  pageInfo(): Promise<Result<PageInfo | { readonly dialog: DialogInfo }, CdpError>>;
  takeDialog(): DialogInfo | null;
  listTabs(includeInternal?: boolean): Promise<Result<ReadonlyArray<TabInfo>, CdpError>>;
  switchTab(targetId: string): Promise<Result<void, CdpError>>;
  newTab(url?: string): Promise<Result<string, CdpError>>;
  closeTab(targetId: string): Promise<Result<void, CdpError>>;
  owns(targetId: string): boolean;
  ownership(): OwnershipRegistry;
  current(): { readonly sessionId: string; readonly targetId: string } | null;
  session(): CdpSession;
  transport(): CdpTransport;
  /** Returns the shared async mutex that serialized browser tools must acquire
   *  before performing mutations. Observation tools should not use this. */
  mutationMutex(): Mutex;
};

const HEALTH_TTL_MS = 30_000;
const PAGE_INFO_TTL_MS = 1_000;

const parsePageInfoPayload = (v: unknown): Result<PageInfo, CdpError> => {
  if (typeof v !== "object" || v === null) {
    return err(cdpError("invalid_response", "page info payload is not an object"));
  }
  const o = v as Readonly<Record<string, unknown>>;
  const fields: ReadonlyArray<readonly [string, "string" | "number"]> = [
    ["url", "string"], ["title", "string"],
    ["w", "number"], ["h", "number"],
    ["sx", "number"], ["sy", "number"],
    ["pw", "number"], ["ph", "number"],
  ];
  for (const [k, t] of fields) {
    if (typeof o[k] !== t) {
      return err(cdpError("invalid_response", `page info field ${k} has wrong type (expected ${t})`));
    }
  }
  return ok({
    url: o["url"] as string,
    title: o["title"] as string,
    width: o["w"] as number,
    height: o["h"] as number,
    scrollX: o["sx"] as number,
    scrollY: o["sy"] as number,
    pageWidth: o["pw"] as number,
    pageHeight: o["ph"] as number,
  });
};

export const createBrowserClient = (opts: BrowserClientOptions): BrowserClient => {
  const transport = opts.transport ?? createCdpTransport();
  const ownershipInit: { ownedTargetIds?: ReadonlyArray<string>; harnessWindowTargetId?: string } = {};
  if (opts.initialOwnership?.ownedTargetIds !== undefined) {
    ownershipInit.ownedTargetIds = opts.initialOwnership.ownedTargetIds;
  }
  if (opts.initialOwnership?.harnessWindowTargetId !== undefined) {
    ownershipInit.harnessWindowTargetId = opts.initialOwnership.harnessWindowTargetId;
  }
  const ownership = createOwnershipRegistry(ownershipInit);
  if (opts.onOwnershipChange) {
    const cb = opts.onOwnershipChange;
    ownership.onChange(() => {
      cb({
        ownedTargetIds: ownership.list(),
        harnessWindowTargetId: ownership.harnessWindow(),
      });
    });
  }
  const session = createCdpSession(transport, ownership);
  const mutationMutex = createMutex();
  let lastHealth = 0;
  let pageCaches = new Map<string, { readonly info: PageInfo; readonly at: number }>();
  let remote: BrowserClientOptions["remote"] | null = opts.remote ?? null;

  const start = async (): Promise<Result<void, CdpError>> => {
    if (transport.state() === "open" && session.current()) return ok(undefined);
    const envUrl = process.env["BU_CDP_WS"];
    let wsUrl: string;
    if (remote?.cdpUrl) {
      wsUrl = remote.cdpUrl;
    } else if (envUrl) {
      wsUrl = envUrl;
    } else {
      const discovered = await discoverWsUrl();
      if (!discovered.success) return discovered;
      wsUrl = discovered.data;
    }
    const connected = await transport.connect(wsUrl, { timeoutMs: 10_000 });
    if (!connected.success) return connected;
    if (!remote) {
      remote = { cdpUrl: wsUrl, browserId: wsUrl.split("/").pop() ?? "unknown" };
    }
    const attached = await session.attachFirstPage();
    if (!attached.success) {
      await transport.close();
      return attached;
    }
    lastHealth = Date.now();
    pageCaches.clear();
    return ok(undefined);
  };

  const stop = async (): Promise<void> => {
    await transport.close();
    pageCaches.clear();
    lastHealth = 0;
  };

  const ensureAlive = async (): Promise<Result<void, CdpError>> => {
    if (transport.state() !== "open" || !session.current()) {
      await stop();
      return start();
    }
    if (Date.now() - lastHealth < HEALTH_TTL_MS) return ok(undefined);
    const probe = await transport.request("Target.getTargets", {}, { sessionId: null, timeoutMs: 2_000 });
    if (!probe.success) {
      await stop();
      return start();
    }
    lastHealth = Date.now();
    // Verify the page session is still responsive (handles the case where the
    // browser transport is alive but the page target crashed, e.g. localhost died).
    const jsProbe = await session.call("Runtime.evaluate", {
      expression: "1", returnByValue: true,
    }, { timeoutMs: 2_000 });
    if (!jsProbe.success && jsProbe.error.kind === "session_not_found") {
      const reattached = await session.attachFirstPage();
      if (reattached.success) {
        pageCaches.clear();
        return ok(undefined);
      }
      await stop();
      return start();
    }
    return ok(undefined);
  };

  const evaluateJs = async (expression: string, sessionId?: string): Promise<Result<unknown, CdpError>> => {
    // Heuristic IIFE wrap: legacy convenience that lets agents write
    // `return foo` instead of `(() => foo)()`. Only wrap when the trimmed
    // source *starts with* a return statement — a bare expression, or one that
    // merely mentions `return` inside a string literal or comment, is passed
    // through untouched (previously any substring `"return "` triggered a wrap,
    // silently turning such expressions into `undefined`).
    const trimmed = expression.trim();
    const isReturnStatement = /^return[\s(]/.test(trimmed);
    const wrapped = isReturnStatement ? `(function(){${expression}})()` : expression;
    const r = sessionId
      ? await session.callOnTarget("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true }, sessionId)
      : await session.call("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true });
    if (!r.success) return r;
    const data = r.data as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (data.exceptionDetails) {
      return err(cdpError("remote_error", `JS evaluation failed: ${JSON.stringify(data.exceptionDetails)}`, "Runtime.evaluate"));
    }
    return ok(data.result?.value);
  };

  const readPageInfo = async (): Promise<Result<PageInfo, CdpError>> => {
    const dirty = session.drainPageInfoInvalidations();
    const currentTid = session.current()?.targetId;
    const cached = currentTid ? pageCaches.get(currentTid) : undefined;
    if (cached && !dirty && Date.now() - cached.at < PAGE_INFO_TTL_MS) return ok(cached.info);
    const expr = safeJs`JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})`;
    const raw = await evaluateJs(expr);
    if (!raw.success) return raw;
    if (typeof raw.data !== "string") return err(cdpError("invalid_response", "page info evaluation did not return a string"));
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(raw.data);
    } catch (e) {
      return err(cdpError("invalid_response", `page info JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    const info = parsePageInfoPayload(parsedRaw);
    if (!info.success) return info;
    if (currentTid) pageCaches.set(currentTid, { info: info.data, at: Date.now() });
    return ok(info.data);
  };

  const pageInfo = async (): Promise<Result<PageInfo | { readonly dialog: DialogInfo }, CdpError>> => {
    const d = session.takeDialog();
    if (d) return ok({ dialog: d });
    return readPageInfo();
  };

  const listTabs = async (includeInternal = true): Promise<Result<ReadonlyArray<TabInfo>, CdpError>> => {
    const r = await session.callBrowser("Target.getTargets");
    if (!r.success) return r;
    const data = r.data as { targetInfos: ReadonlyArray<{ targetId: string; type: string; title: string; url: string }> };
    const tabs = data.targetInfos
      .filter((t) => t.type === "page")
      .filter((t) => includeInternal || !t.url.startsWith("chrome://"))
      .map((t): TabInfo => ({
        targetId: t.targetId,
        title: t.title,
        url: t.url,
        owned: ownership.has(t.targetId),
      }));
    // Reconcile any persisted owned ids that no longer exist as live page targets.
    const live = new Set(tabs.map((t) => t.targetId));
    const owned = ownership.list();
    const survivors = owned.filter((id) => live.has(id));
    if (survivors.length !== owned.length) ownership.replaceAll(survivors);
    const hw = ownership.harnessWindow();
    if (hw && !live.has(hw)) ownership.setHarnessWindow(undefined);
    // Prune per-tab page caches for tabs that no longer exist
    for (const tid of pageCaches.keys()) {
      if (!live.has(tid)) pageCaches.delete(tid);
    }
    return ok(tabs);
  };

  const switchTab = async (targetId: string): Promise<Result<void, CdpError>> => {
    const r = await session.switchTo(targetId);
    if (!r.success) return r;
    // pageCache per-tab: no longer cleared — each tab retains its cache
    // Best-effort: mark the tab title with a green circle so the user can
    // see which tab the agent attached to. CSP or detached frames may
    // block the eval; we don't surface that as a switchTab failure.
    await session.call("Runtime.evaluate", {
      expression: safeJs`if(!document.title.startsWith('🟢'))document.title='🟢 '+document.title`,
    });
    return ok(undefined);
  };

  const newTab = async (url?: string): Promise<Result<string, CdpError>> => {
    // Verify the recorded harness window still exists. Querying the live
    // target list also gives listTabs's reconciliation a chance to run.
    const tabsResult = await listTabs(true);
    if (!tabsResult.success) return tabsResult;
    const live = new Set(tabsResult.data.map((t) => t.targetId));
    const hw = ownership.harnessWindow();

    const params: Record<string, unknown> = { url: "about:blank" };
    if (hw && live.has(hw)) {
      // Open as a child of the harness window's seed tab — Chrome places
      // it in the same window, giving us visual grouping for free.
      params["openerId"] = hw;
    } else {
      // Either fresh session or the harness window was closed by the user.
      // Spawn a new dedicated window.
      params["newWindow"] = true;
    }
    const created = await session.callBrowser("Target.createTarget", params);
    if (!created.success) return created;
    const c = created.data as { targetId: string };

    if (params["newWindow"]) ownership.setHarnessWindow(c.targetId);
    ownership.add(c.targetId);

    const switched = await switchTab(c.targetId);
    if (!switched.success) return switched;
    if (url && url !== "about:blank") {
      const nav = await session.call("Page.navigate", { url });
      if (!nav.success) return nav;
    }
    return ok(c.targetId);
  };

  const closeTab = async (targetId: string): Promise<Result<void, CdpError>> => {
    const r = await session.callBrowser("Target.closeTarget", { targetId });
    if (!r.success) return r;
    ownership.remove(targetId);
    return ok(undefined);
  };

  const status = (): DaemonStatus => ({
    alive: transport.state() === "open" && session.current() !== null,
    sessionId: session.current()?.sessionId ?? null,
    namespace: opts.namespace,
    ...(remote?.browserId !== undefined ? { remoteBrowserId: remote.browserId } : {}),
  });

  const detach = async (): Promise<void> => {
    const cur = session.current();
    if (!cur) return;
    // Target.detachFromTarget removes the "Chrome is being controlled" banner
    // and releases the page session. The transport (WebSocket/Unix socket)
    // stays alive for reuse by the next session.
    // Reference: https://chromedevtools.github.io/devtools-protocol/tot/Target/#method-detachFromTarget
    await transport.request("Target.detachFromTarget", { sessionId: cur.sessionId }, { sessionId: null });
  };

  return {
    namespace: opts.namespace,
    ensureAlive, status, start, stop, detach,
    evaluateJs, pageInfo,
    takeDialog: () => session.takeDialog(),
    listTabs, switchTab, newTab, closeTab,
    owns: (id: string) => ownership.has(id),
    ownership: () => ownership,
    current: () => session.current(),
    session: () => session,
    transport: () => transport,
    mutationMutex: () => mutationMutex,
  };
};
