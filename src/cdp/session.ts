import { type Result, ok } from "../util/result";
import type { CdpError } from "./errors";
import type { DialogInfo } from "./types";
import type { OwnershipRegistry } from "./ownership";
import type { CdpTransport } from "./transport";
import { type CdpMethod, type ParamsOf, type ResultOf, decodeResult } from "./commands";
import { decodeEvent } from "./events";
import { createNetworkBuffer, type DrainResult, type NetworkFilter } from "./network-buffer";
import { createConsoleBuffer, type ConsoleDrainResult, type ConsoleFilter } from "./console-buffer";
import { attachTo } from "./attach";
import { getWindowId } from "./window";

type TabSession = {
  sessionId: string;
  targetId: string;
  dialog: DialogInfo | null;
  pageInfoDirty: boolean;
  networkBuffer: ReturnType<typeof createNetworkBuffer>;
  consoleBuffer: ReturnType<typeof createConsoleBuffer>;
  refMap: Map<string, number>;
  refSig: Map<string, string>;
};

const dialogType = (raw: string): DialogInfo["type"] =>
  raw === "confirm" || raw === "prompt" || raw === "beforeunload" ? raw : "alert";

export type CdpSession = {
  attachFirstPage(): Promise<Result<{ readonly targetId: string; readonly sessionId: string }, CdpError>>;
  switchTo(targetId: string): Promise<Result<void, CdpError>>;
  current(): { readonly sessionId: string; readonly targetId: string } | null;
  setRefMap(refMap: Map<string, number>, refSig: Map<string, string>): void;
  resolveRef(ref: string): number | undefined;
  refSignatures(): ReadonlyMap<string, string>;
  refMappings(): ReadonlyMap<string, number>;
  call<M extends CdpMethod>(method: M, params?: ParamsOf<M>, opts?: { timeoutMs?: number }): Promise<Result<ResultOf<M>, CdpError>>;
  callOnTarget<M extends CdpMethod>(method: M, params: ParamsOf<M>, sessionId: string, opts?: { timeoutMs?: number }): Promise<Result<ResultOf<M>, CdpError>>;
  callBrowser<M extends CdpMethod>(method: M, params?: ParamsOf<M>, opts?: { timeoutMs?: number }): Promise<Result<ResultOf<M>, CdpError>>;
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

  const resolveTab = (evSessionId?: string): TabSession | undefined => {
    const tid = evSessionId ? sessionIdToTargetId.get(evSessionId) : targetId;
    return tid ? tabs.get(tid) : undefined;
  };

  const consumeEvents = async (): Promise<void> => {
    for await (const ev of transport.events()) {
      if (ev.method !== "Target.targetDestroyed") {
        if (ev.sessionId && !sessionIdToTargetId.has(ev.sessionId)) continue;
      }
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
          if (!ownership) break;
          const decoded = decodeEvent(ev.method, ev.params);
          if (!decoded.success || !decoded.data.targetId) break;
          const destroyed = decoded.data.targetId;
          ownership.remove(destroyed);
          const tab = tabs.get(destroyed);
          if (tab) {
            sessionIdToTargetId.delete(tab.sessionId);
            tabs.delete(destroyed);
          }
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
    }
  };

  const restartConsumer = (): void => {
    activeConsumer = activeConsumer.then(() => consumeEvents()).catch((e: unknown) => {
      console.warn("[pi-browser-harness] CDP event consumer crashed:", e);
    });
  };

  restartConsumer();
  transport.onClose(() => {
    sessionId = null;
    targetId = null;
    tabs.clear();
    sessionIdToTargetId.clear();
    // Do NOT clear `dialog` here: a pending takeDialog() must still see it.
    restartConsumer();
  });

  const enableDomains = async (sid: string): Promise<void> => {
    for (const d of ["Page", "DOM", "Runtime", "Network", "Accessibility", "Log"]) {
      await transport.request(`${d}.enable`, {}, { sessionId: sid });
    }
  };

  const req = async <M extends CdpMethod>(
    method: M,
    params: ParamsOf<M> | undefined,
    sid: string | null,
    opts: { timeoutMs?: number } = {},
  ): Promise<Result<ResultOf<M>, CdpError>> => {
    const raw = await transport.request(method, { ...(params ?? {}) }, {
      sessionId: sid,
      ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
    });
    if (!raw.success) return raw;
    return decodeResult(method, raw.data);
  };

  const session: CdpSession = {
    async attachFirstPage() {
      await req("Target.setDiscoverTargets", { discover: true }, null);

      const targets = await req("Target.getTargets", {}, null);
      if (!targets.success) return targets;
      const allPages = targets.data.targetInfos.filter((t) => t.type === "page");
      if (ownership) {
        const live = new Set(allPages.map((p) => p.targetId));
        const survivors = ownership.list().filter((id) => live.has(id));
        if (survivors.length !== ownership.list().length) ownership.replaceAll(survivors);
        const hw = ownership.harnessWindow();
        if (hw && !live.has(hw)) ownership.setHarnessWindow(undefined);

        const anchorId = survivors[0];
        if (anchorId === undefined) {
          ownership.setHarnessWindowId(undefined);
        } else {
          const anchorWin = await getWindowId(session, anchorId);
          if (anchorWin.success) {
            const anchorWindowId = anchorWin.data;
            ownership.setHarnessWindowId(anchorWindowId);
            const windows = await Promise.all(
              allPages.map((p) =>
                p.targetId === anchorId
                  ? Promise.resolve(anchorWin)
                  : getWindowId(session, p.targetId),
              ),
            );
            allPages.forEach((p, i) => {
              const r = windows[i];
              if (r?.success && r.data === anchorWindowId) {
                ownership.add(p.targetId);
              }
            });
          }
          if (!ownership.harnessWindow()) ownership.setHarnessWindow(anchorId);
        }
      }
      const liveTargetIds = new Set(allPages.map((p) => p.targetId));
      for (const tid of tabs.keys()) {
        if (!liveTargetIds.has(tid)) {
          const tab = tabs.get(tid);
          if (tab) sessionIdToTargetId.delete(tab.sessionId);
          tabs.delete(tid);
        }
      }

      let pickTargetId: string | undefined;
      if (ownership) {
        const ownedLive = ownership.list().filter((id) => allPages.some((p) => p.targetId === id));
        pickTargetId = ownedLive[0];
      }
      if (!pickTargetId && createSeedTarget) {
        const seeded = await createSeedTarget();
        if (!seeded.success) return seeded;
        pickTargetId = seeded.data;
      }
      if (!pickTargetId) {
        const created = await req(
          "Target.createTarget",
          { url: "about:blank", ...(ownership ? { newWindow: true } : {}) },
          null,
        );
        if (!created.success) return created;
        pickTargetId = created.data.targetId;
        if (ownership) {
          ownership.setHarnessWindow(created.data.targetId);
          ownership.add(created.data.targetId);
          const win = await getWindowId(session, created.data.targetId);
          if (win.success) ownership.setHarnessWindowId(win.data);
        }
      }

      const attached = await attachTo(session, pickTargetId);
      if (!attached.success) return attached;
      const attachedSessionId = attached.data;
      sessionId = attachedSessionId;
      targetId = pickTargetId;
      tabs.set(pickTargetId, {
        sessionId: attachedSessionId,
        targetId: pickTargetId,
        dialog: null,
        pageInfoDirty: false,
        networkBuffer: createNetworkBuffer(),
        consoleBuffer: createConsoleBuffer(),
        refMap: new Map(),
        refSig: new Map(),
      });
      sessionIdToTargetId.set(attachedSessionId, pickTargetId);
      await enableDomains(attachedSessionId);
      return ok({ targetId: pickTargetId, sessionId: attachedSessionId });
    },
    async switchTo(tid) {
      const activated = await req("Target.activateTarget", { targetId: tid }, null);
      if (!activated.success) return activated;
      const attached = await attachTo(session, tid);
      if (!attached.success) return attached;
      const attachedSessionId = attached.data;
      const existing = tabs.get(tid);
      const tab: TabSession = existing ?? {
        sessionId: attachedSessionId,
        targetId: tid,
        dialog: null,
        pageInfoDirty: true,
        networkBuffer: createNetworkBuffer(),
        consoleBuffer: createConsoleBuffer(),
        refMap: new Map(),
        refSig: new Map(),
      };
      if (existing) {
        sessionIdToTargetId.delete(existing.sessionId);
        existing.sessionId = attachedSessionId;
      } else {
        tabs.set(tid, tab);
      }
      sessionIdToTargetId.set(attachedSessionId, tid);
      await enableDomains(attachedSessionId);
      sessionId = tab.sessionId;
      targetId = tid;
      return ok(undefined);
    },
    current() {
      return sessionId && targetId ? { sessionId, targetId } : null;
    },
    setRefMap(refMap, refSig) {
      const tab = targetId ? tabs.get(targetId) : undefined;
      if (!tab) return;
      tab.refMap = refMap;
      tab.refSig = refSig;
    },
    resolveRef(ref) {
      const tab = targetId ? tabs.get(targetId) : undefined;
      return tab?.refMap.get(ref);
    },
    refSignatures() {
      const tab = targetId ? tabs.get(targetId) : undefined;
      return tab?.refSig ?? new Map();
    },
    refMappings() {
      const tab = targetId ? tabs.get(targetId) : undefined;
      return tab?.refMap ?? new Map();
    },
    call(method, params, opts) {
      return req(method, params, sessionId, opts);
    },
    callOnTarget(method, params, sid, opts) {
      return req(method, params, sid, opts);
    },
    callBrowser(method, params, opts) {
      return req(method, params, null, opts);
    },
    takeDialog() {
      const tab = targetId ? tabs.get(targetId) : undefined;
      if (!tab) return null;
      const d = tab.dialog;
      tab.dialog = null;
      return d;
    },
    drainPageInfoInvalidations() {
      const tab = targetId ? tabs.get(targetId) : undefined;
      if (!tab) return false;
      const dirty = tab.pageInfoDirty;
      tab.pageInfoDirty = false;
      return dirty;
    },
    drainNetworkBuffer(filter) {
      const tab = targetId ? tabs.get(targetId) : undefined;
      if (!tab) return { records: [], total: 0, bufferOverflowed: false };
      return tab.networkBuffer.drain(filter);
    },
    drainConsoleBuffer(filter) {
      const tab = targetId ? tabs.get(targetId) : undefined;
      if (!tab) return { records: [], total: 0, bufferOverflowed: false };
      return tab.consoleBuffer.drain(filter);
    },
  };
  return session;
};
