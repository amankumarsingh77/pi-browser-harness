import { type Result, err, ok } from "./util/result";
import { safeJs } from "./util/js-template";
import { type Mutex, createMutex } from "./util/mutex";
import { discoverEndpoint } from "./cdp/discovery";
import { type CdpError, cdpError } from "./cdp/errors";
import type { CdpTransport } from "./cdp/transport";
import { createCdpTransport } from "./cdp/transport";
import { type CdpSession, createCdpSession } from "./cdp/session";
import { type OwnershipRegistry, createOwnershipRegistry } from "./cdp/ownership";
import { ensureHarnessWindow, openHarnessTab } from "./cdp/target-factory";
import { seedProfileWindow } from "./profile/bind";
import type { ProfilePin } from "./profile/store";
import type { DaemonStatus, DialogInfo, PageInfo, TabInfo } from "./cdp/types";

export type BrowserClientOptions = {
  readonly namespace: string;
  readonly transport?: CdpTransport;
  readonly remote?: { readonly cdpUrl: string; readonly browserId: string };
  readonly initialOwnership?: {
    readonly ownedTargetIds?: ReadonlyArray<string>;
    readonly harnessWindowTargetId?: string;
    readonly harnessWindowId?: number;
  };
  /** Profile to pin this session to, loaded from the durable pin store. */
  readonly profilePin?: ProfilePin | null;
  readonly onOwnershipChange?: (snapshot: {
    readonly ownedTargetIds: ReadonlyArray<string>;
    readonly harnessWindowTargetId: string | undefined;
    readonly harnessWindowId: number | undefined;
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
  /** Close every tab this session owns and clear the window binding. Best-effort —
   *  used on session shutdown so no stale harness tabs survive. */
  closeOwnedTabs(): Promise<void>;
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
  /** User-data-dir of the connected browser, when discovery could determine it.
   *  Undefined for BU_CDP_WS / bare-port connections, where profile selection
   *  is unavailable. */
  userDataDir(): string | undefined;
  /** The profile this session is pinned to, or null when unpinned. */
  profilePin(): ProfilePin | null;
  setProfilePin(pin: ProfilePin | null): void;
  /** browserContextId of the pinned profile, once a window has identified it.
   *  Session-scoped: Chrome re-mints context ids on every browser run. */
  profileContextId(): string | undefined;
  setProfileContextId(contextId: string | undefined): void;
  /** Open and adopt a window inside the pinned profile. Returns its seed tab. */
  seedPinnedProfileWindow(): Promise<Result<string, CdpError>>;
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
  const ownershipInit: { ownedTargetIds?: ReadonlyArray<string>; harnessWindowTargetId?: string; harnessWindowId?: number } = {};
  if (opts.initialOwnership?.ownedTargetIds !== undefined) {
    ownershipInit.ownedTargetIds = opts.initialOwnership.ownedTargetIds;
  }
  if (opts.initialOwnership?.harnessWindowTargetId !== undefined) {
    ownershipInit.harnessWindowTargetId = opts.initialOwnership.harnessWindowTargetId;
  }
  if (opts.initialOwnership?.harnessWindowId !== undefined) {
    ownershipInit.harnessWindowId = opts.initialOwnership.harnessWindowId;
  }
  const ownership = createOwnershipRegistry(ownershipInit);
  if (opts.onOwnershipChange) {
    const cb = opts.onOwnershipChange;
    ownership.onChange(() => {
      cb({
        ownedTargetIds: ownership.list(),
        harnessWindowTargetId: ownership.harnessWindow(),
        harnessWindowId: ownership.harnessWindowId(),
      });
    });
  }
  // The seed provider routes attachFirstPage's fallback through the target
  // factory, so a pinned profile is honoured on every path that can create the
  // harness window.
  const session = createCdpSession(transport, ownership, async () => {
    const window = await ensureHarnessWindow(api);
    return window.success ? ok(window.data.targetId) : window;
  });
  const mutationMutex = createMutex();
  let lastHealth = 0;
  let pageCaches = new Map<string, { readonly info: PageInfo; readonly at: number }>();
  let remote: BrowserClientOptions["remote"] | null = opts.remote ?? null;
  let userDataDir: string | undefined;
  let profilePin: ProfilePin | null = opts.profilePin ?? null;
  let profileContextId: string | undefined;

  /**
   * With a profile pinned, the harness window must exist BEFORE anything
   * attaches: session.attachFirstPage() would otherwise fall back to a bare
   * Target.createTarget, which lands in the focus-derived default profile.
   * Seeding first means attachFirstPage always finds an owned tab to attach to.
   */
  const seedIfPinned = async (): Promise<Result<void, CdpError>> => {
    if (!profilePin) return ok(undefined);
    const window = await ensureHarnessWindow(api);
    if (!window.success) return window;
    return ok(undefined);
  };

  const start = async (): Promise<Result<void, CdpError>> => {
    if (transport.state() === "open" && session.current()) return ok(undefined);
    const envUrl = process.env["BU_CDP_WS"];
    let wsUrl: string;
    if (remote?.cdpUrl) {
      wsUrl = remote.cdpUrl;
    } else if (envUrl) {
      wsUrl = envUrl;
    } else {
      const discovered = await discoverEndpoint();
      if (!discovered.success) return discovered;
      wsUrl = discovered.data.wsUrl;
      userDataDir = discovered.data.userDataDir;
    }
    const connected = await transport.connect(wsUrl, { timeoutMs: 10_000 });
    if (!connected.success) return connected;

    const newBrowserId: string = wsUrl.split("/").pop() ?? "unknown";
    if (!remote || remote.browserId !== newBrowserId) {
      profileContextId = undefined;
    }
    remote = { cdpUrl: wsUrl, browserId: newBrowserId };
    const seeded = await seedIfPinned();
    if (!seeded.success) {
      await transport.close();
      return seeded;
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
      // Re-seed first when pinned: if the user closed every harness tab,
      // attachFirstPage would mint a window in the focus-derived profile.
      const seeded = await seedIfPinned();
      if (!seeded.success) return seeded;
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
    const expr = safeJs`JSON.stringify((function(){var e=document.documentElement||{scrollWidth:0,scrollHeight:0};return {url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:e.scrollWidth,ph:e.scrollHeight};})())`;
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
    // Reconcile ownership against live targets before deciding where to open.
    const tabsResult = await listTabs(true);
    if (!tabsResult.success) return tabsResult;

    // ensureHarnessWindow reuses the seed tab, falls back to any surviving
    // owned tab, and only then creates a window — which, when a profile is
    // pinned, means launching one inside that profile.
    const window = await ensureHarnessWindow(api);
    if (!window.success) return window;
    // A freshly created window IS the new tab; opening another would leave a
    // stray blank tab behind.
    let tabId: string;
    if (window.data.freshlyCreated) {
      tabId = window.data.targetId;
    } else {
      const opened = await openHarnessTab(api, window.data.targetId);
      if (!opened.success) return opened;
      tabId = opened.data;
    }

    const switched = await switchTab(tabId);
    if (!switched.success) return switched;
    if (url && url !== "about:blank") {
      const nav = await session.call("Page.navigate", { url });
      if (!nav.success) return nav;
    }
    return ok(tabId);
  };

  const closeTab = async (targetId: string): Promise<Result<void, CdpError>> => {
    const r = await session.callBrowser("Target.closeTarget", { targetId });
    if (!r.success) return r;
    ownership.remove(targetId);
    return ok(undefined);
  };

  const closeOwnedTabs = async (): Promise<void> => {
    // Snapshot first — remove() mutates the list, and targetDestroyed events
    // may also prune concurrently. Failures are swallowed: a tab the user
    // already closed, or a dead transport, must not block shutdown.
    for (const id of ownership.list()) {
      await session.callBrowser("Target.closeTarget", { targetId: id }).catch(() => {});
      ownership.remove(id);
    }
    ownership.setHarnessWindow(undefined);
    ownership.setHarnessWindowId(undefined);
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

  const api: BrowserClient = {
    namespace: opts.namespace,
    ensureAlive, status, start, stop, detach, closeOwnedTabs,
    evaluateJs, pageInfo,
    takeDialog: () => session.takeDialog(),
    listTabs, switchTab, newTab, closeTab,
    owns: (id: string) => ownership.has(id),
    ownership: () => ownership,
    current: () => session.current(),
    session: () => session,
    transport: () => transport,
    userDataDir: () => userDataDir,
    profilePin: () => profilePin,
    setProfilePin: (pin) => {
      const changed = pin === null
        ? profilePin !== null
        : profilePin === null || profilePin.userDataDir !== pin.userDataDir || profilePin.profileDir !== pin.profileDir;
      profilePin = pin;
      if (changed) {
        profileContextId = undefined;
      }
    },
    profileContextId: () => profileContextId,
    setProfileContextId: (contextId) => {
      profileContextId = contextId;
    },
    seedPinnedProfileWindow: async () => {
      if (!profilePin) {
        return err(cdpError("discovery_failed", "no browser profile is selected — run /browser-profile"));
      }
      return seedProfileWindow(api, profilePin);
    },
    mutationMutex: () => mutationMutex,
  };
  return api;
};
