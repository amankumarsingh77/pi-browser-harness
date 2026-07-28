import WebSocket from "ws";
import { discoverWsUrl } from "../cdp/discovery";
import { isCdpRawMessage } from "../cdp/types";
import type { CdpRawMessage } from "../cdp/types";
import type { WireRequest, WireResponse, WireEvent } from "./protocol";
import { CDP_CONNECT_TIMEOUT_MS, CDP_COMMAND_TIMEOUT_MS } from "./protocol";
import { asString, isRecord } from "../util/guards";

export type SendToClient = (clientId: string, msg: WireResponse | WireEvent) => void;

export type EventHandler = (event: WireEvent, targetClientIds: string[]) => void;

export type CloseHandler = () => void;

export type CdpBridge = {
  start(): Promise<void>;
  stop(): Promise<void>;
  handleRequest(req: WireRequest, clientId: string, send: SendToClient): Promise<void>;
  isAlive(): boolean;
  getSessionOwner(sessionId: string): string | undefined;
  removeClient(clientId: string): void;
  onEvent(handler: EventHandler): void;
  onClose(handler: CloseHandler): void;
};

interface PendingEntry {
  clientId: string;
  localId: number;
}

class IdMultiplexer {
  private nextId = 1;
  private localToRemote = new Map<string, Map<number, number>>();
  private pending = new Map<number, PendingEntry>();

  allocate(clientId: string, localId: number): number {
    const daemonId = this.nextId++;
    let m = this.localToRemote.get(clientId);
    if (!m) { m = new Map(); this.localToRemote.set(clientId, m); }
    m.set(localId, daemonId);
    this.pending.set(daemonId, { clientId, localId });
    return daemonId;
  }

  resolve(daemonId: number): PendingEntry | null {
    const e = this.pending.get(daemonId);
    if (!e) return null;
    this.pending.delete(daemonId);
    const m = this.localToRemote.get(e.clientId);
    if (m) m.delete(e.localId);
    return e;
  }

  clearClient(clientId: string): void {
    const m = this.localToRemote.get(clientId);
    if (m) { for (const [, did] of m) this.pending.delete(did); }
    this.localToRemote.delete(clientId);
  }
}

class EventRouter {
  private owners = new Map<string, string>();
  private clientSessions = new Map<string, Set<string>>();

  record(clientId: string, sessionId: string): void {
    const prev = this.owners.get(sessionId);
    if (prev && prev !== clientId) {
      this.clientSessions.get(prev)?.delete(sessionId);
    }
    this.owners.set(sessionId, clientId);
    let s = this.clientSessions.get(clientId);
    if (!s) { s = new Set(); this.clientSessions.set(clientId, s); }
    s.add(sessionId);
  }

  release(sessionId: string): void {
    const owner = this.owners.get(sessionId);
    if (owner) this.clientSessions.get(owner)?.delete(sessionId);
    this.owners.delete(sessionId);
  }

  getOwner(sessionId: string): string | undefined {
    return this.owners.get(sessionId);
  }

  removeClient(clientId: string): void {
    const sessions = this.clientSessions.get(clientId);
    if (sessions) { for (const sid of sessions) this.owners.delete(sid); }
    this.clientSessions.delete(clientId);
  }

  route(event: WireEvent): string[] {
    if (event.sessionId) {
      const owner = this.owners.get(event.sessionId);
      return owner ? [owner] : [];
    }
    return [...this.clientSessions.keys()];
  }
}

export const createCdpBridge = (): CdpBridge => {
  let ws: WebSocket | null = null;
  let wsUrl: string | null = null;
  const mux = new IdMultiplexer();
  const router = new EventRouter();
  let eventHandler: EventHandler | null = null;
  let closeHandler: CloseHandler | null = null;

  const callbacks = new Map<number, {
    send: SendToClient;
    clientId: string;
    localId: number;
    timer: ReturnType<typeof setTimeout>;
    isAttach: boolean;
  }>();

  const onChromeMessage = (raw: string): void => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (!isCdpRawMessage(parsed)) return;
    const msg: CdpRawMessage = parsed;

    if (msg.id !== undefined) {
      const cb = callbacks.get(msg.id);
      if (!cb) {
        mux.resolve(msg.id);
        return;
      }
      clearTimeout(cb.timer);
      callbacks.delete(msg.id);

      const localId = cb.localId;

      if (msg.error) {
        cb.send(cb.clientId, {
          type: "response",
          id: localId,
          error: { code: msg.error.code ?? -1, message: msg.error.message },
        });
      } else {
        if (cb.isAttach && msg.result) {
          const sessionId = isRecord(msg.result) ? asString(msg.result["sessionId"]) : undefined;
          if (sessionId) {
            router.record(cb.clientId, sessionId);
          }
        }
        cb.send(cb.clientId, { type: "response", id: localId, result: msg.result });
      }

      mux.resolve(msg.id);
      return;
    }

    if (!msg.method) return;

    if (msg.method === "Inspector.detached" && msg.sessionId) {
      router.release(msg.sessionId);
    }

    const wireEvent: WireEvent = {
      type: "event",
      method: msg.method,
      ...(msg.params !== undefined ? { params: msg.params } : {}),
      ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
    };

    if (eventHandler) {
      const targets = router.route(wireEvent);
      if (targets.length > 0) {
        eventHandler(wireEvent, targets);
      }
    }
  };

  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectAttempt = 0;
  let stopped = false;

  const tryConnect = (): void => {
    if (stopped) return;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }

    const attempt = async (): Promise<void> => {
      if (ws && ws.readyState === WebSocket.OPEN) return;

      const cachedUrl = wsUrl;
      let url: string;
      if (cachedUrl === null || cachedUrl === "" || reconnectAttempt > 0) {
        const d = await discoverWsUrl();
        if (!d.success) { scheduleRetry(); return; }
        url = d.data;
        wsUrl = url;
      } else {
        url = cachedUrl;
      }

      const settledPromise = new Promise<void>((settle) => {
        let settled = false;
        const settleOnce = (): void => {
          if (settled) return;
          settled = true;
          settle();
        };

        let sock: WebSocket;
        try {
          sock = new WebSocket(url, { perMessageDeflate: false });
        } catch {
          scheduleRetry();
          return;
        }

        const timer = setTimeout(() => {
          sock.close();
          settleOnce();
        }, CDP_CONNECT_TIMEOUT_MS);

        sock.on("open", () => {
          clearTimeout(timer);
          ws = sock;
          reconnectAttempt = 0;
          ws.send(JSON.stringify({ id: 0, method: "Target.setDiscoverTargets", params: { discover: true } }));
          console.log("[pi-browser-daemon] Connected to Chrome ✓");
          settleOnce();
        });

        sock.on("message", (data: WebSocket.Data) => {
          onChromeMessage(typeof data === "string" ? data : data.toString());
        });

        sock.on("error", () => {
          clearTimeout(timer);
          settleOnce();
        });

        sock.on("close", () => {
          clearTimeout(timer);
          ws = null;
          for (const [daemonId, cb] of callbacks) {
            clearTimeout(cb.timer);
            cb.send(cb.clientId, {
              type: "response",
              id: cb.localId,
              error: { code: -32000, message: "Chrome disconnected" },
            });
            callbacks.delete(daemonId);
            mux.resolve(daemonId);
          }
          closeHandler?.();
          scheduleRetry();
        });
      });

      await settledPromise;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        scheduleRetry();
      }
    };

    attempt().catch(() => scheduleRetry());
  };

  const scheduleRetry = (): void => {
    if (stopped) return;
    const delay = Math.min(1000 * Math.pow(2, Math.min(reconnectAttempt, 6)), 60_000);
    reconnectAttempt++;
    wsUrl = null;
    reconnectTimer = setTimeout(tryConnect, delay);
  };

  const start = async (): Promise<void> => {
    stopped = false;
    tryConnect();
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    if (reconnectTimer) { clearTimeout(reconnectTimer); reconnectTimer = null; }
    for (const [, cb] of callbacks) clearTimeout(cb.timer);
    callbacks.clear();
    if (ws) { try { ws.close(1000, "Shutdown"); } catch {} ws = null; }
    wsUrl = null;
  };

  const handleRequest = async (
    req: WireRequest,
    clientId: string,
    send: SendToClient,
  ): Promise<void> => {
    if (!ws || ws.readyState !== WebSocket.OPEN) {
      const deadline = Date.now() + 15_000;
      while (Date.now() < deadline) {
        await new Promise((r) => setTimeout(r, 250));
        if (ws && ws.readyState === WebSocket.OPEN) break;
      }
    }

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      send(clientId, {
        type: "response",
        id: req.id,
        error: { code: -32000, message: "Chrome not connected" },
      });
      return;
    }

    const daemonId = mux.allocate(clientId, req.id);

    const timer = setTimeout(() => {
      callbacks.delete(daemonId);
      mux.resolve(daemonId);
      send(clientId, {
        type: "response",
        id: req.id,
        error: { code: -32000, message: `Timeout after ${CDP_COMMAND_TIMEOUT_MS}ms: ${req.method}` },
      });
    }, CDP_COMMAND_TIMEOUT_MS);

    const isAttach = req.method === "Target.attachToTarget";
    const isDetach = req.method === "Target.detachFromTarget";

    if (isDetach && req.sessionId) {
      router.release(req.sessionId);
    }

    callbacks.set(daemonId, { send, clientId, localId: req.id, timer, isAttach });

    const payload: Record<string, unknown> = {
      id: daemonId,
      method: req.method,
      params: req.params ?? {},
    };
    if (req.sessionId) payload["sessionId"] = req.sessionId;

    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      clearTimeout(timer);
      callbacks.delete(daemonId);
      mux.resolve(daemonId);
      send(clientId, {
        type: "response",
        id: req.id,
        error: { code: -32000, message: e instanceof Error ? e.message : String(e) },
      });
    }
  };

  return {
    start,
    stop,
    handleRequest,
    isAlive: () => ws !== null && ws.readyState === WebSocket.OPEN,
    getSessionOwner: (sid) => router.getOwner(sid),
    removeClient: (cid) => { mux.clearClient(cid); router.removeClient(cid); },
    onEvent: (h) => { eventHandler = h; },
    onClose: (h) => { closeHandler = h; },
  };
};
