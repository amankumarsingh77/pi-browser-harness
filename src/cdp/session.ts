import { type Result, err, ok } from "../util/result";
import { type CdpError, cdpError } from "./errors";
import type { DialogInfo } from "./types";
import { isInternalUrl } from "./types";
import type { CdpTransport } from "./transport";

export type CdpSession = {
  attachFirstPage(): Promise<Result<{ readonly targetId: string; readonly sessionId: string }, CdpError>>;
  switchTo(targetId: string): Promise<Result<void, CdpError>>;
  current(): { readonly sessionId: string; readonly targetId: string } | null;
  call(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<Result<unknown, CdpError>>;
  callOnTarget(method: string, params: Record<string, unknown>, sessionId: string, opts?: { timeoutMs?: number }): Promise<Result<unknown, CdpError>>;
  callBrowser(method: string, params?: Record<string, unknown>, opts?: { timeoutMs?: number }): Promise<Result<unknown, CdpError>>;
  takeDialog(): DialogInfo | null;
  drainPageInfoInvalidations(): boolean;
};

export const createCdpSession = (transport: CdpTransport): CdpSession => {
  let sessionId: string | null = null;
  let targetId: string | null = null;
  let dialog: DialogInfo | null = null;
  let pageInfoDirty = false;

  let activeConsumer: Promise<void> = Promise.resolve();

  const consumeEvents = async (): Promise<void> => {
    for await (const ev of transport.events()) {
      if (ev.method === "Page.javascriptDialogOpening") {
        const params = ev.params as Partial<DialogInfo> | undefined;
        dialog = {
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
        pageInfoDirty = true;
      }
    }
  };

  const restartConsumer = (): void => {
    activeConsumer = activeConsumer.then(() => consumeEvents()).catch(() => undefined);
  };

  restartConsumer();
  transport.onClose(() => {
    sessionId = null;
    targetId = null;
    pageInfoDirty = false;
    // Do NOT clear `dialog` here — same rationale as inside consumeEvents:
    // the agent may have a pending takeDialog() call that should still see it.
    restartConsumer();
  });

  // TODO(perf): the four enable calls are sequential here for predictability.
  // Switching to Promise.all over a single WS pipelines the round-trips and
  // saves ~3× on tab-switch latency. Defer until session.ts has tests.
  const enableDomains = async (sid: string): Promise<void> => {
    for (const d of ["Page", "DOM", "Runtime", "Network"]) {
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
      const targets = await transport.request("Target.getTargets", {}, { sessionId: null });
      if (!targets.success) return targets;
      const data = targets.data as { targetInfos: ReadonlyArray<{ targetId: string; type: string; url: string }> };
      let pages = data.targetInfos.filter((t) => t.type === "page" && !isInternalUrl(t.url));
      if (pages.length === 0) {
        const created = await transport.request("Target.createTarget", { url: "about:blank" }, { sessionId: null });
        if (!created.success) return created;
        const c = created.data as { targetId: string };
        pages = [{ targetId: c.targetId, type: "page", url: "about:blank" }];
      }
      const first = pages[0];
      if (!first) return err(cdpError("invalid_response", "no page targets after creation"));
      const attached = await transport.request("Target.attachToTarget", { targetId: first.targetId, flatten: true }, { sessionId: null });
      if (!attached.success) return attached;
      const a = attached.data as { sessionId: string };
      sessionId = a.sessionId;
      targetId = first.targetId;
      await enableDomains(a.sessionId);
      return ok({ targetId: first.targetId, sessionId: a.sessionId });
    },
    async switchTo(tid) {
      const activated = await transport.request("Target.activateTarget", { targetId: tid }, { sessionId: null });
      if (!activated.success) return activated;
      const attached = await transport.request("Target.attachToTarget", { targetId: tid, flatten: true }, { sessionId: null });
      if (!attached.success) return attached;
      const a = attached.data as { sessionId: string };
      sessionId = a.sessionId;
      targetId = tid;
      pageInfoDirty = true;
      await enableDomains(a.sessionId);
      return ok(undefined);
    },
    current() {
      return sessionId && targetId ? { sessionId, targetId } : null;
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
      const d = dialog;
      dialog = null;
      return d;
    },
    drainPageInfoInvalidations() {
      const dirty = pageInfoDirty;
      pageInfoDirty = false;
      return dirty;
    },
  };
};
