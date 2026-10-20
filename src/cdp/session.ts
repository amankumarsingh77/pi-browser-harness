import { map, type Result, err, ok } from "../util/result";
import { asString, isRecord } from "../util/guards";
import { type CdpError, cdpError } from "./errors";
import type { CdpEvent, DialogInfo, RefSignature } from "./types";
import { type OwnershipRegistry, reconcileOwnership } from "./ownership";
import type { CdpTransport } from "./types";
import { type CdpMethod, type ParamsOf, type ResultOf, decodeResult } from "./commands";

export type CallOpts = { readonly timeoutMs?: number };

// True when every key of P is optional (so `{}` is a valid P); false when at least one key is required.
type HasOnlyOptionalKeys<P> = Partial<P> extends P ? true : false;

// The trailing arguments of `call`/`callBrowser`: params may be omitted exactly when the method's params object has
// no required key, so `call("Page.enable")` compiles and `call("Page.navigate")` does not.
export type CallArgs<M extends CdpMethod> = HasOnlyOptionalKeys<ParamsOf<M>> extends true
  ? [params?: ParamsOf<M>, opts?: CallOpts]
  : [params: ParamsOf<M>, opts?: CallOpts];
import { decodeEvent } from "./events";
import { createNetworkBuffer, type DrainResult, type NetworkBuffer, type NetworkFilter } from "./network-buffer";
import { createConsoleBuffer, type ConsoleBuffer, type ConsoleDrainResult, type ConsoleFilter } from "./console-buffer";

type TabSession = {
  sessionId: string;
  readonly targetId: string;
  dialog: DialogInfo | null;
  pageInfoDirty: boolean;
  readonly networkBuffer: NetworkBuffer;
  readonly consoleBuffer: ConsoleBuffer;
  refMap: ReadonlyMap<string, number>;
  refSig: ReadonlyMap<string, RefSignature>;
};

type PageTarget = { readonly targetId: string; readonly type: string };

const ENABLED_DOMAINS: ReadonlyArray<string> = ["Page", "DOM", "Runtime", "Network", "Accessibility", "Log"];

const dialogType = (raw: string): DialogInfo["type"] =>
  raw === "confirm" || raw === "prompt" || raw === "beforeunload" ? raw : "alert";

export type CdpSession = {
  attachFirstPage(): Promise<Result<{ readonly targetId: string; readonly sessionId: string }, CdpError>>;
  // Raw attach: the returned session is NOT tracked (no domains enabled, no event routing). Pair it with `detach`.
  attach(targetId: string): Promise<Result<string, CdpError>>;
  detach(sessionId: string): Promise<Result<void, CdpError>>;
  // Detaches every tracked session and forgets them all.
  detachAll(): Promise<void>;
  // The tracked, domain-enabled session for a target, if this instance holds one.
  sessionFor(targetId: string): string | undefined;
  windowId(targetId: string): Promise<Result<number, CdpError>>;
  switchTo(targetId: string): Promise<Result<void, CdpError>>;
  current(): { readonly sessionId: string; readonly targetId: string } | null;
  setRefMap(refMap: ReadonlyMap<string, number>, refSig: ReadonlyMap<string, RefSignature>): void;
  resolveRef(ref: string): number | undefined;
  refSignatures(): ReadonlyMap<string, RefSignature>;
  refMappings(): ReadonlyMap<string, number>;
  // Sends on the current page session. Params are required only when the method has a required key (see CallArgs).
  call<M extends CdpMethod>(method: M, ...args: CallArgs<M>): Promise<Result<ResultOf<M>, CdpError>>;
  // Sends on an explicit session id (a borrowed or background tab). Params always come first because the session id follows them.
  callOnTarget<M extends CdpMethod>(method: M, params: ParamsOf<M>, sessionId: string, opts?: CallOpts): Promise<Result<ResultOf<M>, CdpError>>;
  // Sends on the browser-level connection (no session id).
  callBrowser<M extends CdpMethod>(method: M, ...args: CallArgs<M>): Promise<Result<ResultOf<M>, CdpError>>;
  takeDialog(): DialogInfo | null;
  drainPageInfoInvalidations(): boolean;
  drainNetworkBuffer(filter: NetworkFilter): DrainResult;
  drainConsoleBuffer(filter: ConsoleFilter): ConsoleDrainResult;
};

// Injected so seeding goes through the target factory; attachFirstPage's own `Target.createTarget` would land in whichever profile has focus.
export type SeedTargetProvider = () => Promise<Result<string, CdpError>>;

export const createCdpSession = (
  transport: CdpTransport,
  ownership?: OwnershipRegistry,
  createSeedTarget?: SeedTargetProvider,
): CdpSession => {
  let sessionId: string | null = null;
  let targetId: string | null = null;

  const tabs = new Map<string, TabSession>();
  const sessionIdToTargetId = new Map<string, string>();

  let activeConsumer: Promise<void> = Promise.resolve();

  const clearCurrent = (): void => {
    sessionId = null;
    targetId = null;
  };

  const freshTab = (tid: string, sid: string, pageInfoDirty: boolean): TabSession => ({
    sessionId: sid,
    targetId: tid,
    dialog: null,
    pageInfoDirty,
    networkBuffer: createNetworkBuffer(),
    consoleBuffer: createConsoleBuffer(),
    refMap: new Map(),
    refSig: new Map(),
  });

  // Binds a session to a target. An existing tab keeps its buffers, refs and dialog; only its session id changes.
  const bindSession = (tid: string, sid: string, pageInfoDirty: boolean): TabSession => {
    const existing = tabs.get(tid);
    if (existing) {
      sessionIdToTargetId.delete(existing.sessionId);
      existing.sessionId = sid;
      sessionIdToTargetId.set(sid, tid);
      return existing;
    }
    const tab = freshTab(tid, sid, pageInfoDirty);
    tabs.set(tid, tab);
    sessionIdToTargetId.set(sid, tid);
    return tab;
  };

  // A session is gone (detached by us, by Chrome, or with its target). Only the tab still bound to it is dropped, so a stale notice for a replaced session is harmless.
  const forgetSession = (sid: string): void => {
    const tid = sessionIdToTargetId.get(sid);
    sessionIdToTargetId.delete(sid);
    if (tid === undefined) return;
    const tab = tabs.get(tid);
    if (tab?.sessionId === sid) tabs.delete(tid);
    if (sessionId === sid) clearCurrent();
  };

  const forgetTarget = (tid: string): void => {
    const tab = tabs.get(tid);
    if (tab) {
      sessionIdToTargetId.delete(tab.sessionId);
      tabs.delete(tid);
    }
    if (targetId === tid) clearCurrent();
  };

  const resolveTab = (evSessionId?: string): TabSession | undefined => {
    const tid = evSessionId ? sessionIdToTargetId.get(evSessionId) : targetId;
    return tid ? tabs.get(tid) : undefined;
  };

  const isTargetLifecycleEvent = (method: string): boolean =>
    method === "Target.targetDestroyed" || method === "Target.detachedFromTarget";

  const handleEvent = (ev: CdpEvent): void => {
    if (!isTargetLifecycleEvent(ev.method) && ev.sessionId && !sessionIdToTargetId.has(ev.sessionId)) return;
    switch (ev.method) {
      case "Page.javascriptDialogOpening": {
        const tab = resolveTab(ev.sessionId);
        if (!tab) break;
        const decoded = decodeEvent(ev.method, ev.params);
        tab.dialog = decoded.success
          ? {
              type: dialogType(decoded.data.type),
              message: decoded.data.message,
              ...(decoded.data.defaultPrompt !== undefined
                ? { defaultPrompt: decoded.data.defaultPrompt }
                : {}),
            }
          : { type: "alert", message: "" };
        break;
      }
      // Intentionally NOT cleared on javascriptDialogClosed: a fast dismiss would otherwise drop a dialog the agent was about to read.
      case "Page.frameNavigated":
      case "Page.loadEventFired": {
        const tab = resolveTab(ev.sessionId);
        if (tab) tab.pageInfoDirty = true;
        break;
      }
      case "Target.targetCreated": {
        if (!ownership) break;
        const decoded = decodeEvent(ev.method, ev.params);
        if (!decoded.success) break;
        const info = decoded.data.targetInfo;
        if (info.type === "page" && info.targetId && info.openerId && ownership.has(info.openerId)) {
          ownership.add(info.targetId);
        }
        break;
      }
      case "Target.targetDestroyed": {
        const decoded = decodeEvent(ev.method, ev.params);
        if (!decoded.success || !decoded.data.targetId) break;
        const destroyed = decoded.data.targetId;
        ownership?.remove(destroyed);
        forgetTarget(destroyed);
        break;
      }
      // Browser-level notice that a session ended; carries the session id in params rather than on the envelope.
      case "Target.detachedFromTarget": {
        const sid = isRecord(ev.params) ? asString(ev.params["sessionId"]) : undefined;
        if (sid !== undefined) forgetSession(sid);
        break;
      }
      case "Inspector.detached": {
        if (ev.sessionId !== undefined) forgetSession(ev.sessionId);
        break;
      }
      case "Network.requestWillBeSent": {
        const tab = resolveTab(ev.sessionId);
        if (tab) tab.networkBuffer.ingestRequestWillBeSent(ev.params);
        break;
      }
      case "Network.responseReceived": {
        const tab = resolveTab(ev.sessionId);
        if (tab) tab.networkBuffer.ingestResponseReceived(ev.params);
        break;
      }
      case "Network.loadingFinished": {
        const tab = resolveTab(ev.sessionId);
        if (tab) tab.networkBuffer.ingestLoadingFinished(ev.params);
        break;
      }
      case "Network.loadingFailed": {
        const tab = resolveTab(ev.sessionId);
        if (tab) tab.networkBuffer.ingestLoadingFailed(ev.params);
        break;
      }
      case "Runtime.consoleAPICalled": {
        const tab = resolveTab(ev.sessionId);
        if (tab) tab.consoleBuffer.ingestConsoleApi(ev.params);
        break;
      }
      case "Log.entryAdded": {
        const tab = resolveTab(ev.sessionId);
        if (tab) tab.consoleBuffer.ingestLogEntry(ev.params);
        break;
      }
      default:
        break;
    }
  };

  const consumeEvents = async (): Promise<void> => {
    for await (const ev of transport.events()) {
      // One bad event must not end the loop: nothing restarts it until the transport closes.
      try {
        handleEvent(ev);
      } catch (e: unknown) {
        console.warn(`[pi-browser-harness] CDP event handler failed for ${ev.method}:`, e);
      }
    }
  };

  const restartConsumer = (): void => {
    activeConsumer = activeConsumer.then(() => consumeEvents()).catch((e: unknown) => {
      console.warn("[pi-browser-harness] CDP event consumer crashed:", e);
    });
  };

  restartConsumer();
  transport.onClose(() => {
    // Everything, pending dialogs included, dies with the socket: the sessions those dialogs belonged to no longer exist, so a later takeDialog() correctly sees nothing.
    clearCurrent();
    tabs.clear();
    sessionIdToTargetId.clear();
    restartConsumer();
  });

  // Not in the typed command table (only Page.enable is), so the raw transport is used and only success is checked.
  const enableDomains = async (sid: string): Promise<Result<void, CdpError>> => {
    for (const d of ENABLED_DOMAINS) {
      const r = await transport.request(`${d}.enable`, {}, { sessionId: sid });
      if (!r.success) return r;
    }
    return ok(undefined);
  };

  const req = async <M extends CdpMethod>(
    method: M,
    params: ParamsOf<M> | undefined,
    sid: string | null,
    opts: CallOpts = {},
  ): Promise<Result<ResultOf<M>, CdpError>> => {
    const raw = await transport.request(method, { ...(params ?? {}) }, {
      sessionId: sid,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (!raw.success) return raw;
    return decodeResult(method, raw.data);
  };

  const attach = async (tid: string): Promise<Result<string, CdpError>> =>
    map(await req("Target.attachToTarget", { targetId: tid, flatten: true }, null), (d) => d.sessionId);

  const detachRaw = async (sid: string): Promise<Result<void, CdpError>> =>
    map(await req("Target.detachFromTarget", { sessionId: sid }, null), () => undefined);

  // Best effort: the session may already be gone, which is the outcome we wanted anyway.
  const detachQuietly = async (sid: string): Promise<void> => {
    await detachRaw(sid);
  };

  const windowId = async (tid: string): Promise<Result<number, CdpError>> =>
    map(await req("Browser.getWindowForTarget", { targetId: tid }, null), (d) => d.windowId);

  // Attaches a new session to `tid` with every domain enabled. A previous session on the same target is detached only once the new one is live, so the tab's buffers and refs carry over without leaking the old session.
  const attachFresh = async (tid: string, pageInfoDirty: boolean): Promise<Result<string, CdpError>> => {
    const previous = tabs.get(tid)?.sessionId;
    const attached = await attach(tid);
    if (!attached.success) return attached;
    const sid = attached.data;
    bindSession(tid, sid, pageInfoDirty);
    const enabled = await enableDomains(sid);
    if (!enabled.success) {
      forgetSession(sid);
      await detachQuietly(sid);
      return enabled;
    }
    if (previous !== undefined && previous !== sid) await detachQuietly(previous);
    return ok(sid);
  };

  const discoverPages = async (): Promise<Result<ReadonlyArray<PageTarget>, CdpError>> => {
    const discovering = await req("Target.setDiscoverTargets", { discover: true }, null);
    if (!discovering.success) return discovering;
    const targets = await req("Target.getTargets", {}, null);
    if (!targets.success) return targets;
    return ok(targets.data.targetInfos.filter((t) => t.type === "page"));
  };

  // Drops dead owned targets, then adopts every live page that shares a window with the first surviving owned tab.
  const adoptHarnessWindowTabs = async (
    registry: OwnershipRegistry,
    allPages: ReadonlyArray<PageTarget>,
    live: ReadonlySet<string>,
  ): Promise<void> => {
    const survivors = reconcileOwnership(registry, live);
    const anchorId = survivors[0];
    if (anchorId === undefined) {
      registry.setHarnessWindowId(undefined);
      return;
    }
    const anchorWin = await windowId(anchorId);
    if (anchorWin.success) {
      const anchorWindowId = anchorWin.data;
      registry.setHarnessWindowId(anchorWindowId);
      const windows = await Promise.all(
        allPages.map((p) => (p.targetId === anchorId ? Promise.resolve(anchorWin) : windowId(p.targetId))),
      );
      allPages.forEach((p, i) => {
        const r = windows[i];
        if (r?.success && r.data === anchorWindowId) registry.add(p.targetId);
      });
    }
    if (!registry.harnessWindow()) registry.setHarnessWindow(anchorId);
  };

  const pruneDeadTabs = (live: ReadonlySet<string>): void => {
    for (const tid of [...tabs.keys()]) {
      if (!live.has(tid)) forgetTarget(tid);
    }
  };

  // First live owned page; otherwise a seeded one; otherwise a fresh about:blank (in its own window when ownership is tracked).
  const pickOrCreateTarget = async (live: ReadonlySet<string>): Promise<Result<string, CdpError>> => {
    const ownedLive = ownership?.list().find((id) => live.has(id));
    if (ownedLive !== undefined) return ok(ownedLive);
    if (createSeedTarget) return createSeedTarget();
    const created = await req(
      "Target.createTarget",
      { url: "about:blank", ...(ownership ? { newWindow: true } : {}) },
      null,
    );
    if (!created.success) return created;
    const tid = created.data.targetId;
    if (ownership) {
      ownership.setHarnessWindow(tid);
      ownership.add(tid);
      const win = await windowId(tid);
      if (win.success) ownership.setHarnessWindowId(win.data);
    }
    return ok(tid);
  };

  const currentTab = (): TabSession | undefined => (targetId ? tabs.get(targetId) : undefined);

  const session: CdpSession = {
    async attachFirstPage() {
      const pages = await discoverPages();
      if (!pages.success) return pages;
      const live: ReadonlySet<string> = new Set(pages.data.map((p) => p.targetId));
      if (ownership) await adoptHarnessWindowTabs(ownership, pages.data, live);
      pruneDeadTabs(live);
      const picked = await pickOrCreateTarget(live);
      if (!picked.success) return picked;
      const tid = picked.data;
      // Always a fresh session: callers reach this on start or after the current session was reported dead.
      const attached = await attachFresh(tid, false);
      if (!attached.success) return attached;
      sessionId = attached.data;
      targetId = tid;
      return ok({ targetId: tid, sessionId: attached.data });
    },
    async switchTo(tid) {
      const activated = await req("Target.activateTarget", { targetId: tid }, null);
      if (!activated.success) return activated;
      const existing = tabs.get(tid);
      if (existing) {
        sessionId = existing.sessionId;
        targetId = tid;
        return ok(undefined);
      }
      const attached = await attachFresh(tid, true);
      if (!attached.success) return attached;
      sessionId = attached.data;
      targetId = tid;
      return ok(undefined);
    },
    attach,
    async detach(sid) {
      forgetSession(sid);
      return detachRaw(sid);
    },
    async detachAll() {
      const sids = [...sessionIdToTargetId.keys()];
      clearCurrent();
      tabs.clear();
      sessionIdToTargetId.clear();
      await Promise.all(sids.map(detachQuietly));
    },
    sessionFor(tid) {
      return tabs.get(tid)?.sessionId;
    },
    windowId,
    current() {
      return sessionId && targetId ? { sessionId, targetId } : null;
    },
    setRefMap(refMap, refSig) {
      const tab = currentTab();
      if (!tab) return;
      // Copied so later mutation of the caller's maps cannot change what resolveRef sees.
      tab.refMap = new Map(refMap);
      tab.refSig = new Map(refSig);
    },
    resolveRef(ref) {
      const tab = currentTab();
      return tab?.refMap.get(ref);
    },
    refSignatures() {
      const tab = currentTab();
      return tab?.refSig ?? new Map();
    },
    refMappings() {
      const tab = currentTab();
      return tab?.refMap ?? new Map();
    },
    call(method, ...args) {
      const [params, opts] = args;
      return req(method, params, sessionId, opts);
    },
    callOnTarget(method, params, sid, opts) {
      return req(method, params, sid, opts);
    },
    callBrowser(method, ...args) {
      const [params, opts] = args;
      return req(method, params, null, opts);
    },
    takeDialog() {
      const tab = currentTab();
      if (!tab) return null;
      const d = tab.dialog;
      tab.dialog = null;
      return d;
    },
    drainPageInfoInvalidations() {
      const tab = currentTab();
      if (!tab) return false;
      const dirty = tab.pageInfoDirty;
      tab.pageInfoDirty = false;
      return dirty;
    },
    drainNetworkBuffer(filter) {
      const tab = currentTab();
      if (!tab) return { records: [], total: 0, bufferOverflowed: false };
      return tab.networkBuffer.drain(filter);
    },
    drainConsoleBuffer(filter) {
      const tab = currentTab();
      if (!tab) return { records: [], total: 0, bufferOverflowed: false };
      return tab.consoleBuffer.drain(filter);
    },
  };
  return session;
};

export const evaluateJson = async <T>(
  session: CdpSession,
  expression: string,
  check: (v: unknown) => v is T,
  opts?: { sessionId?: string | undefined; timeoutMs?: number | undefined },
): Promise<Result<T, CdpError>> => {
  const params = {
    expression,
    returnByValue: true,
    awaitPromise: true,
  };
  const callOpts = opts?.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {};
  const r = opts?.sessionId !== undefined
    ? await session.callOnTarget("Runtime.evaluate", params, opts.sessionId, callOpts)
    : await session.call("Runtime.evaluate", params, callOpts);
  if (!r.success) return r;
  const { result, exceptionDetails } = r.data;
  if (exceptionDetails !== undefined) {
    return err(cdpError("remote_error", exceptionDetails.text, "Runtime.evaluate"));
  }
  const value = result.value;
  if (!check(value)) {
    return err(cdpError("invalid_response", `unexpected evaluate shape (type: ${result.type}) for: ${expression.slice(0, 60)}`, "Runtime.evaluate"));
  }
  return ok(value);
};
