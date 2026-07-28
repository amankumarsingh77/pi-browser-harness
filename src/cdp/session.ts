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

// Per-tab state. One TabSession exists per known targetId.
// Dialog, page-info dirty flag, and CDP buffers are per-tab — switching
// tabs preserves the previous tab's data in its TabSession instead of
// clearing it.
type TabSession = {
  sessionId: string;
  targetId: string;
  dialog: DialogInfo | null;
  pageInfoDirty: boolean;
  networkBuffer: ReturnType<typeof createNetworkBuffer>;
  consoleBuffer: ReturnType<typeof createConsoleBuffer>;
  // Stable element refs (e1, e2, …) → CDP backendNodeId, from the latest
  // snapshot of this tab. Replaced wholesale on every snapshot — old refs are
  // stale anyway, so this stays bounded (~50–60 KB worst case).
  refMap: Map<string, number>;
  // Per-ref signature ("role|name|value") from the latest snapshot, used as the
  // baseline for the post-mutation auto-diff. Replaced alongside refMap.
  refSig: Map<string, string>;
};

const dialogType = (raw: string): DialogInfo["type"] =>
  raw === "confirm" || raw === "prompt" || raw === "beforeunload" ? raw : "alert";

export type CdpSession = {
  attachFirstPage(): Promise<Result<{ readonly targetId: string; readonly sessionId: string }, CdpError>>;
  switchTo(targetId: string): Promise<Result<void, CdpError>>;
  current(): { readonly sessionId: string; readonly targetId: string } | null;
  /** Replace the active tab's ref map and ref signatures (from a fresh snapshot). */
  setRefMap(refMap: Map<string, number>, refSig: Map<string, string>): void;
  /** Resolve a ref (e.g. "e12") to its backendNodeId on the active tab, or undefined if unknown/stale. */
  resolveRef(ref: string): number | undefined;
  /** The active tab's prior ref signatures — baseline for the post-mutation diff. */
  refSignatures(): ReadonlyMap<string, string>;
  call<M extends CdpMethod>(method: M, params?: ParamsOf<M>, opts?: { timeoutMs?: number }): Promise<Result<ResultOf<M>, CdpError>>;
  callOnTarget<M extends CdpMethod>(method: M, params: ParamsOf<M>, sessionId: string, opts?: { timeoutMs?: number }): Promise<Result<ResultOf<M>, CdpError>>;
  callBrowser<M extends CdpMethod>(method: M, params?: ParamsOf<M>, opts?: { timeoutMs?: number }): Promise<Result<ResultOf<M>, CdpError>>;
  takeDialog(): DialogInfo | null;
  drainPageInfoInvalidations(): boolean;
  drainNetworkBuffer(filter: NetworkFilter): DrainResult;
  drainConsoleBuffer(filter: ConsoleFilter): ConsoleDrainResult;
};

/**
 * Supplies the seed tab when attachFirstPage finds no owned tab to attach to.
 * Injected by the client so that seeding goes through the target factory —
 * which, with a profile pinned, opens the window inside that profile. Without
 * it, attachFirstPage's own `Target.createTarget` would land in whichever
 * profile currently has focus.
 *
 * The provider is responsible for its own ownership bookkeeping.
 */
export type SeedTargetProvider = () => Promise<Result<string, CdpError>>;

export const createCdpSession = (
  transport: CdpTransport,
  ownership?: OwnershipRegistry,
  createSeedTarget?: SeedTargetProvider,
): CdpSession => {
  let sessionId: string | null = null;
  let targetId: string | null = null;

  // Per-tab tracking: maps targetId → TabSession and sessionId → targetId for
  // event routing. Lazy: a TabSession is created on the first visit to a tab.
  const tabs = new Map<string, TabSession>();
  const sessionIdToTargetId = new Map<string, string>();

  let activeConsumer: Promise<void> = Promise.resolve();

  // Event → TabSession resolver. Uses sessionId from CDP events to find the
  // correct TabSession, falling back to the current targetId when no sessionId.
  const resolveTab = (evSessionId?: string): TabSession | undefined => {
    const tid = evSessionId ? sessionIdToTargetId.get(evSessionId) : targetId;
    return tid ? tabs.get(tid) : undefined;
  };

  const consumeEvents = async (): Promise<void> => {
    for await (const ev of transport.events()) {
      // Filter: skip events from sessions we're not currently tracking.
      // Target.targetDestroyed is browser-level (no sessionId) — always process.
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
        // Page.javascriptDialogClosed is intentionally NOT cleared here —
        // the dialog stays in the buffer until takeDialog() is called.
        // This prevents fast dismiss flows from dropping a dialog the agent
        // was about to read. (Fix for spec §7 predictability bug #2.)
        case "Page.frameNavigated":
        case "Page.loadEventFired": {
          const tab = resolveTab(ev.sessionId);
          if (tab) tab.pageInfoDirty = true;
          break;
        }
        case "Target.targetCreated": {
          // Adopt tabs opened BY a tab we already own (window.open, target=_blank,
          // popups). Chrome sets openerId to the opener target; if that opener is
          // owned, the child belongs to this session's window and must be
          // controllable + cleaned up. Targets the user opens themselves have no
          // owned opener, so they are never adopted.
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
          // Prune per-tab state for the destroyed target
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
      // The .then() chain calls consumeEvents() which iterates the transport's
      // events() AsyncIterable. The iterable resolves cleanly on close (returns
      // {done:true}); any rejection here is an unexpected bug in the event
      // handler, not a normal termination. Surface it on stderr so it's not lost.
      console.warn("[pi-browser-harness] CDP event consumer crashed:", e);
    });
  };

  restartConsumer();
  transport.onClose(() => {
    sessionId = null;
    targetId = null;
    tabs.clear();
    sessionIdToTargetId.clear();
    // Do NOT clear `dialog` here — same rationale as inside consumeEvents:
    // the agent may have a pending takeDialog() call that should still see it.
    restartConsumer();
  });

  // TODO(perf): the four enable calls are sequential here for predictability.
  // Switching to Promise.all over a single WS pipelines the round-trips and
  // saves ~3× on tab-switch latency. Defer until session.ts has tests.
  const enableDomains = async (sid: string): Promise<void> => {
    for (const d of ["Page", "DOM", "Runtime", "Network", "Accessibility", "Log"]) {
      await transport.request(`${d}.enable`, {}, { sessionId: sid });
    }
  };

  // The one place `unknown` ends for every CDP call this session makes — its
  // own internal bookkeeping calls (attach/switch) and the public
  // call/callOnTarget/callBrowser all funnel through here. A single
  // transport-then-decode implementation means a future change (tracing,
  // error wrapping, the short-circuit on failure) lands in one place, and a
  // new internal call site can't forget to decode.
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
      // Subscribe to Target.* events so we can react to targetDestroyed.
      // Best-effort: failing to enable discovery is not fatal for attach.
      await req("Target.setDiscoverTargets", { discover: true }, null);

      const targets = await req("Target.getTargets", {}, null);
      if (!targets.success) return targets;
      const allPages = targets.data.targetInfos.filter((t) => t.type === "page");
      // Reconcile the persisted ownership set against live targets — drop dead IDs.
      if (ownership) {
        const live = new Set(allPages.map((p) => p.targetId));
        const survivors = ownership.list().filter((id) => live.has(id));
        if (survivors.length !== ownership.list().length) ownership.replaceAll(survivors);
        const hw = ownership.harnessWindow();
        if (hw && !live.has(hw)) ownership.setHarnessWindow(undefined);

        const anchorId = survivors[0];
        if (anchorId === undefined) {
          // No owned tab survived — the harness window is gone (user closed it,
          // or Chrome restarted and reassigned all ids). The persisted windowId
          // is now meaningless and could even collide with one of the user's
          // windows, so drop it. attachFirstPage will mint a fresh window below.
          ownership.setHarnessWindowId(undefined);
        } else {
          // Self-heal ownership from the window itself. We anchor on a tab we
          // KNOW we own (a survivor) and re-adopt only its live window-mates —
          // popups/children from last session, tabs reopened in our window.
          // Ownership is thus DERIVED from the real window, never from the bare
          // persisted integer (which Chrome may reassign to a user window on
          // restart — anchoring on a survivor makes that misfire impossible).
          const anchorWin = await getWindowId(session, anchorId);
          if (anchorWin.success) {
            const anchorWindowId = anchorWin.data;
            ownership.setHarnessWindowId(anchorWindowId); // refresh to the live id
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
      // Prune per-tab state for pages that no longer exist
      const liveTargetIds = new Set(allPages.map((p) => p.targetId));
      for (const tid of tabs.keys()) {
        if (!liveTargetIds.has(tid)) {
          const tab = tabs.get(tid);
          if (tab) sessionIdToTargetId.delete(tab.sessionId);
          tabs.delete(tid);
        }
      }

      // Prefer attaching to a tab this session already owns. Falls back to
      // creating a fresh harness-owned tab in a dedicated window — never
      // grabs the user's foreground tab.
      let pickTargetId: string | undefined;
      if (ownership) {
        const ownedLive = ownership.list().filter((id) => allPages.some((p) => p.targetId === id));
        pickTargetId = ownedLive[0];
      }
      if (!pickTargetId && createSeedTarget) {
        // Delegated seeding (see SeedTargetProvider): the provider creates the
        // window in the right profile and records ownership itself.
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
          // Capture the real Chrome windowId — the durable identity of the
          // window this session initialized (survives seed-tab closure).
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
      // Reuse existing TabSession or create one on first visit
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
        // Each Target.attachToTarget produces a new sessionId — update it.
        sessionIdToTargetId.delete(existing.sessionId);
        existing.sessionId = attachedSessionId;
      } else {
        tabs.set(tid, tab);
      }
      sessionIdToTargetId.set(attachedSessionId, tid);
      await enableDomains(attachedSessionId);
      // Update global pointers to point at the new active tab
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
