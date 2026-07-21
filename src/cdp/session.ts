import { type Result, ok } from "../util/result";
import type { CdpError } from "./errors";
import type { DialogInfo } from "./types";
import type { OwnershipRegistry } from "./ownership";
import type { CdpTransport } from "./transport";
import { createNetworkBuffer, type DrainResult, type NetworkFilter } from "./network-buffer";
import { createConsoleBuffer, type ConsoleDrainResult, type ConsoleFilter } from "./console-buffer";

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
  call(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<Result<unknown, CdpError>>;
  callOnTarget(method: string, params: Record<string, unknown>, sessionId: string, opts?: { timeoutMs?: number }): Promise<Result<unknown, CdpError>>;
  callBrowser(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<Result<unknown, CdpError>>;
  takeDialog(): DialogInfo | null;
  drainPageInfoInvalidations(): boolean;
  drainNetworkBuffer(filter: NetworkFilter): DrainResult;
  drainConsoleBuffer(filter: ConsoleFilter): ConsoleDrainResult;
};

export const createCdpSession = (
  transport: CdpTransport,
  ownership?: OwnershipRegistry,
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
        if (ev.sessionId && ev.sessionId !== sessionId) continue;
      }
      if (ev.method === "Page.javascriptDialogOpening") {
        const tab = targetId ? tabs.get(targetId) : undefined;
        if (!tab) continue;
        const params = ev.params as Partial<DialogInfo> | undefined;
        tab.dialog = {
          type: (params?.type as DialogInfo["type"]) ?? "alert",
          message: params?.message ?? "",
          ...(params?.defaultPrompt !== undefined ? { defaultPrompt: params.defaultPrompt } : {}),
        };
        continue;
      }
      // Page.javascriptDialogClosed is intentionally NOT cleared here —
      // the dialog stays in the buffer until takeDialog() is called.
      // This prevents fast dismiss flows from dropping a dialog the agent
      // was about to read. (Fix for spec §7 predictability bug #2.)
      if (ev.method === "Page.frameNavigated" || ev.method === "Page.loadEventFired") {
        const tab = targetId ? tabs.get(targetId) : undefined;
        if (tab) tab.pageInfoDirty = true;
      }
      if (ev.method === "Target.targetCreated" && ownership) {
        // Adopt tabs opened BY a tab we already own (window.open, target=_blank,
        // popups). Chrome sets openerId to the opener target; if that opener is
        // owned, the child belongs to this session's window and must be
        // controllable + cleaned up. Targets the user opens themselves have no
        // owned opener, so they are never adopted.
        const info = (ev.params as { targetInfo?: { targetId?: string; type?: string; openerId?: string } } | undefined)?.targetInfo;
        if (info?.type === "page" && info.targetId && info.openerId && ownership.has(info.openerId)) {
          ownership.add(info.targetId);
        }
      }
      if (ev.method === "Target.targetDestroyed" && ownership) {
        const params = ev.params as { targetId?: string } | undefined;
        if (params?.targetId) {
          ownership.remove(params.targetId);
          // Prune per-tab state for the destroyed target
          const tab = tabs.get(params.targetId);
          if (tab) {
            sessionIdToTargetId.delete(tab.sessionId);
            tabs.delete(params.targetId);
          }
        }
      }
      if (ev.method === "Network.requestWillBeSent") {
        const tab = resolveTab(ev.sessionId);
        if (tab) tab.networkBuffer.ingestRequestWillBeSent(ev.params);
      } else if (ev.method === "Network.responseReceived") {
        const tab = resolveTab(ev.sessionId);
        if (tab) tab.networkBuffer.ingestResponseReceived(ev.params);
      } else if (ev.method === "Network.loadingFinished") {
        const tab = resolveTab(ev.sessionId);
        if (tab) tab.networkBuffer.ingestLoadingFinished(ev.params);
      } else if (ev.method === "Network.loadingFailed") {
        const tab = resolveTab(ev.sessionId);
        if (tab) tab.networkBuffer.ingestLoadingFailed(ev.params);
      } else if (ev.method === "Runtime.consoleAPICalled") {
        const tab = resolveTab(ev.sessionId);
        if (tab) tab.consoleBuffer.ingestConsoleApi(ev.params);
      } else if (ev.method === "Log.entryAdded") {
        const tab = resolveTab(ev.sessionId);
        if (tab) tab.consoleBuffer.ingestLogEntry(ev.params);
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

  // CDP response shapes are documented in chromedevtools.github.io but not
  // available as TypeScript types. We cast `as` from `unknown` only in this
  // file (the CDP boundary). Each cast is paired with the CDP method that
  // produced the response. Adding runtime guards for every shape would be
  // noise — Chrome's protocol is stable enough that a wrong cast surfaces
  // as a clear Error in normal use.
  return {
    async attachFirstPage() {
      // Subscribe to Target.* events so we can react to targetDestroyed.
      // Best-effort: failing to enable discovery is not fatal for attach.
      await transport.request("Target.setDiscoverTargets", { discover: true }, { sessionId: null });

      const targets = await transport.request("Target.getTargets", {}, { sessionId: null });
      if (!targets.success) return targets;
      const data = targets.data as { targetInfos: ReadonlyArray<{ targetId: string; type: string; url: string }> };
      const allPages = data.targetInfos.filter((t) => t.type === "page");
      // Reconcile the persisted ownership set against live targets — drop dead IDs.
      if (ownership) {
        const live = new Set(allPages.map((p) => p.targetId));
        const survivors = ownership.list().filter((id) => live.has(id));
        if (survivors.length !== ownership.list().length) ownership.replaceAll(survivors);
        const hw = ownership.harnessWindow();
        if (hw && !live.has(hw)) ownership.setHarnessWindow(undefined);

        if (survivors.length === 0) {
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
          const anchorId = survivors[0]!;
          const anchorWin = await transport.request("Browser.getWindowForTarget", { targetId: anchorId }, { sessionId: null });
          if (anchorWin.success) {
            const anchorWindowId = (anchorWin.data as { windowId?: number }).windowId;
            if (typeof anchorWindowId === "number") {
              ownership.setHarnessWindowId(anchorWindowId); // refresh to the live id
              const windows = await Promise.all(
                allPages.map((p) =>
                  p.targetId === anchorId
                    ? Promise.resolve(anchorWin)
                    : transport.request("Browser.getWindowForTarget", { targetId: p.targetId }, { sessionId: null }),
                ),
              );
              allPages.forEach((p, i) => {
                const r = windows[i];
                if (r?.success && (r.data as { windowId?: number }).windowId === anchorWindowId) {
                  ownership.add(p.targetId);
                }
              });
            }
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
      if (!pickTargetId) {
        const createParams: Record<string, unknown> = { url: "about:blank" };
        if (ownership) createParams["newWindow"] = true;
        const created = await transport.request("Target.createTarget", createParams, { sessionId: null });
        if (!created.success) return created;
        const c = created.data as { targetId: string };
        pickTargetId = c.targetId;
        if (ownership) {
          ownership.setHarnessWindow(c.targetId);
          ownership.add(c.targetId);
          // Capture the real Chrome windowId — the durable identity of the
          // window this session initialized (survives seed-tab closure).
          const win = await transport.request("Browser.getWindowForTarget", { targetId: c.targetId }, { sessionId: null });
          if (win.success) {
            const wid = (win.data as { windowId?: number }).windowId;
            if (typeof wid === "number") ownership.setHarnessWindowId(wid);
          }
        }
      }

      const attached = await transport.request("Target.attachToTarget", { targetId: pickTargetId, flatten: true }, { sessionId: null });
      if (!attached.success) return attached;
      const a = attached.data as { sessionId: string };
      sessionId = a.sessionId;
      targetId = pickTargetId;
      await enableDomains(a.sessionId);
      tabs.set(pickTargetId, {
        sessionId: a.sessionId,
        targetId: pickTargetId,
        dialog: null,
        pageInfoDirty: false,
        networkBuffer: createNetworkBuffer(),
        consoleBuffer: createConsoleBuffer(),
        refMap: new Map(),
        refSig: new Map(),
      });
      sessionIdToTargetId.set(a.sessionId, pickTargetId);
      return ok({ targetId: pickTargetId, sessionId: a.sessionId });
    },
    async switchTo(tid) {
      const activated = await transport.request("Target.activateTarget", { targetId: tid }, { sessionId: null });
      if (!activated.success) return activated;
      const attached = await transport.request("Target.attachToTarget", { targetId: tid, flatten: true }, { sessionId: null });
      if (!attached.success) return attached;
      const a = attached.data as { sessionId: string };
      // Reuse existing TabSession or create one on first visit
      const existing = tabs.get(tid);
      const tab: TabSession = existing ?? {
        sessionId: a.sessionId,
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
        existing.sessionId = a.sessionId;
        sessionIdToTargetId.set(a.sessionId, tid);
      } else {
        tabs.set(tid, tab);
        await enableDomains(a.sessionId);
        sessionIdToTargetId.set(a.sessionId, tid);
      }
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
    call(method, params = {}, opts = {}) {
      return transport.request(method, params, { sessionId, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
    },
    callOnTarget(method, params, sid, opts = {}) {
      return transport.request(method, params, { sessionId: sid, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
    },
    callBrowser(method, params = {}, opts = {}) {
      return transport.request(method, params, { sessionId: null, ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}) });
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
};
