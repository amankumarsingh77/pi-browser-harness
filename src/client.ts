import { DAEMON_RECONNECT_METHOD } from "./daemon/protocol";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { parseJson } from "./schemas/parse";
import { type Result, err, ok } from "./util/result";
import { safeJs } from "./util/js-template";
import { type Mutex, createMutex } from "./util/mutex";
import { discoverEndpoint } from "./cdp/discovery";
import { type CdpError, cdpError } from "./cdp/errors";
import type { CdpTransport } from "./cdp/types";
import { type CdpSession, createCdpSession } from "./cdp/session";
import { type OwnershipRegistry, createOwnershipRegistry, reconcileOwnership } from "./cdp/ownership";
import { ensureHarnessWindow, openHarnessTab } from "./cdp/target-factory";
import { seedProfileWindow } from "./profile/bind";
import type { ProfilePin } from "./profile/store";
import type { DaemonStatus, DialogInfo, PageInfo, PageInfoResult, TabInfo } from "./cdp/types";

export type BrowserClientOptions = {
  readonly namespace: string;
  readonly transport: CdpTransport;
  readonly remote?: { readonly cdpUrl: string; readonly browserId: string };
  readonly initialOwnership?: {
    readonly ownedTargetIds?: ReadonlyArray<string>;
    readonly harnessWindowTargetId?: string;
    readonly harnessWindowId?: number;
  };
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
  // `reconnectNow` is for explicit human demand (/browser-setup, /browser-reload-daemon): it asks the
  // daemon to dial Chrome immediately even if it is cooling down after a failed attempt.
  start(opts?: { readonly reconnectNow?: boolean }): Promise<Result<void, CdpError>>;
  stop(): Promise<void>;
  detach(): Promise<void>;
  closeOwnedTabs(): Promise<void>;
  evaluateJs(expression: string, sessionId?: string): Promise<Result<unknown, CdpError>>;
  pageInfo(): Promise<Result<PageInfoResult, CdpError>>;
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
  userDataDir(): string | undefined;
  profilePin(): ProfilePin | null;
  setProfilePin(pin: ProfilePin | null): void;
  profileContextId(): string | undefined;
  setProfileContextId(contextId: string | undefined): void;
  seedPinnedProfileWindow(): Promise<Result<string, CdpError>>;
  mutationMutex(): Mutex;
};

const HEALTH_TTL_MS = 30_000;
const PAGE_INFO_TTL_MS = 1_000;

const PageInfoPayload = Type.Object({
  url: Type.String(),
  title: Type.String(),
  w: Type.Number(),
  h: Type.Number(),
  sx: Type.Number(),
  sy: Type.Number(),
  pw: Type.Number(),
  ph: Type.Number(),
});

const pageInfoValidator = Compile(PageInfoPayload);

const parsePageInfoPayload = (raw: string): Result<PageInfo, CdpError> => {
  const parsed = parseJson(raw, pageInfoValidator);
  if (!parsed.success) {
    return err(cdpError("invalid_response", `page info payload is invalid: ${parsed.error}`));
  }
  const o = parsed.data;
  return ok({
    url: o.url,
    title: o.title,
    width: o.w,
    height: o.h,
    scrollX: o.sx,
    scrollY: o.sy,
    pageWidth: o.pw,
    pageHeight: o.ph,
  });
};

export const createBrowserClient = (opts: BrowserClientOptions): BrowserClient => {
  const transport = opts.transport;
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
  const session = createCdpSession(transport, ownership, async () => {
    const window = await ensureHarnessWindow(api);
    return window.success ? ok(window.data.targetId) : window;
  });
  const mutationMutex = createMutex();
  let lastHealth = 0;
  let healthCheck: Promise<Result<void, CdpError>> | null = null;
  const pageCaches = new Map<string, { readonly info: PageInfo; readonly at: number }>();
  let remote: BrowserClientOptions["remote"] | null = opts.remote ?? null;
  let userDataDir: string | undefined;
  let profilePin: ProfilePin | null = opts.profilePin ?? null;
  let profileContextId: string | undefined;

  // With a pin set the window must exist BEFORE anything attaches, or attachFirstPage's bare Target.createTarget lands in the focus-derived default profile.
  const seedIfPinned = async (): Promise<Result<void, CdpError>> => {
    if (!profilePin) return ok(undefined);
    const window = await ensureHarnessWindow(api);
    if (!window.success) return window;
    return ok(undefined);
  };

  const start = async (opts: { readonly reconnectNow?: boolean } = {}): Promise<Result<void, CdpError>> => {
    if (transport.state() === "open" && session.current()) return ok(undefined);
    let wsUrl: string;
    if (remote?.cdpUrl) {
      wsUrl = remote.cdpUrl;
    } else {
      const discovered = await discoverEndpoint();
      if (!discovered.success) return discovered;
      wsUrl = discovered.data.wsUrl;
      userDataDir = discovered.data.userDataDir;
    }
    const connected = await transport.connect(wsUrl, { timeoutMs: 10_000 });
    if (!connected.success) return connected;
    if (opts.reconnectNow) {
      // Only the daemon understands this; a direct Chrome transport answers "method not found",
      // which is fine because it has no cooldown to clear.
      const dialed = await transport.request(DAEMON_RECONNECT_METHOD, {}, { timeoutMs: 15_000 });
      if (!dialed.success && dialed.error.kind !== "remote_error") {
        await transport.close();
        return dialed;
      }
    }

    const newBrowserId: string = wsUrl.split("/").pop() ?? "unknown";
    if (remote?.browserId !== newBrowserId) {
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

  const restart = async (): Promise<Result<void, CdpError>> => {
    await stop();
    return start();
  };

  const reattach = async (): Promise<Result<void, CdpError>> => {
    const seeded = await seedIfPinned();
    if (!seeded.success) return seeded;
    const reattached = await session.attachFirstPage();
    if (reattached.success) {
      pageCaches.clear();
      return ok(undefined);
    }
    return restart();
  };

  // Two probes: the browser one proves the socket works, the page one proves the current session does.
  // Only transport-level failures (closed socket, timeout) mean the connection is dead. A page probe that
  // fails for a page-level reason (navigation in flight, a throwing page) still proves the session routes,
  // so it counts as alive; only a dead session id triggers a re-attach.
  const checkHealth = async (): Promise<Result<void, CdpError>> => {
    if (transport.state() !== "open" || !session.current()) return restart();
    if (Date.now() - lastHealth < HEALTH_TTL_MS) return ok(undefined);
    const probe = await session.callBrowser("Target.getTargets", {}, { timeoutMs: 2_000 });
    if (!probe.success) return restart();
    lastHealth = Date.now();
    const jsProbe = await session.call("Runtime.evaluate", {
      expression: "1", returnByValue: true,
    }, { timeoutMs: 2_000 });
    if (jsProbe.success) return ok(undefined);
    switch (jsProbe.error.kind) {
      case "session_not_found":
        return reattach();
      case "transport_closed":
      case "timeout":
        return restart();
      case "discovery_failed":
      case "invalid_response":
      case "remote_error":
        return ok(undefined);
    }
  };

  // Concurrent callers share one in-flight check, so two tools racing after a disconnect cannot both restart the transport.
  const ensureAlive = (): Promise<Result<void, CdpError>> => {
    if (healthCheck) return healthCheck;
    const running = checkHealth().finally(() => {
      healthCheck = null;
    });
    healthCheck = running;
    return running;
  };

  const evaluateJs = async (expression: string, sessionId?: string): Promise<Result<unknown, CdpError>> => {
    // Wrap only when the trimmed source *starts with* `return` — matching the substring anywhere silently turned expressions mentioning it into `undefined`.
    const trimmed = expression.trim();
    const isReturnStatement = /^return[\s(]/.test(trimmed);
    const wrapped = isReturnStatement ? `(function(){${expression}})()` : expression;
    const r = sessionId
      ? await session.callOnTarget("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true }, sessionId)
      : await session.call("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true });
    if (!r.success) return r;
    if (r.data.exceptionDetails !== undefined) {
      return err(cdpError("remote_error", `JS evaluation failed: ${JSON.stringify(r.data.exceptionDetails)}`, "Runtime.evaluate"));
    }
    return ok(r.data.result.value);
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
    const info = parsePageInfoPayload(raw.data);
    if (!info.success) return info;
    if (currentTid) pageCaches.set(currentTid, { info: info.data, at: Date.now() });
    return ok(info.data);
  };

  const pageInfo = async (): Promise<Result<PageInfoResult, CdpError>> => {
    const d = session.takeDialog();
    if (d) return ok({ kind: "dialog", dialog: d });
    const info = await readPageInfo();
    if (!info.success) return info;
    return ok({ kind: "page", ...info.data });
  };

  const listTabs = async (includeInternal = true): Promise<Result<ReadonlyArray<TabInfo>, CdpError>> => {
    const r = await session.callBrowser("Target.getTargets");
    if (!r.success) return r;
    const tabs = r.data.targetInfos
      .filter((t) => t.type === "page")
      .filter((t) => includeInternal || !t.url.startsWith("chrome://"))
      .map((t): TabInfo => ({
        targetId: t.targetId,
        title: t.title,
        url: t.url,
        owned: ownership.has(t.targetId),
      }));
    const live = new Set(tabs.map((t) => t.targetId));
    reconcileOwnership(ownership, live);
    for (const tid of pageCaches.keys()) {
      if (!live.has(tid)) pageCaches.delete(tid);
    }
    return ok(tabs);
  };

  const switchTab = async (targetId: string): Promise<Result<void, CdpError>> => {
    const r = await session.switchTo(targetId);
    if (!r.success) return r;
    await session.call("Runtime.evaluate", {
      expression: safeJs`if(!document.title.startsWith('🟢'))document.title='🟢 '+document.title`,
    });
    return ok(undefined);
  };

  const newTab = async (url?: string): Promise<Result<string, CdpError>> => {
    // ensureHarnessWindow lists live targets and reconciles ownership itself, so no listing is needed here.
    const window = await ensureHarnessWindow(api);
    if (!window.success) return window;
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
    for (const id of ownership.list()) {
      const closed = await session.callBrowser("Target.closeTarget", { targetId: id });
      // A remote error means the browser answered (typically "no target with given id"): the tab is gone either way. A transport failure means nothing was closed, so keep the record for the next attempt.
      if (closed.success || closed.error.kind === "remote_error") ownership.remove(id);
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
    if (transport.state() !== "open") return;
    await session.detachAll();
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
        : profilePin?.userDataDir !== pin.userDataDir || profilePin.profileDir !== pin.profileDir;
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
