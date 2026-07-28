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

export type InFlight = {
  readonly clientId: string;
  readonly localId: number;
  readonly send: SendToClient;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly isAttach: boolean;
};

// One map, keyed by the daemon-side id: the client that asked, the id it used, and everything needed to answer it.
export type IdMultiplexer = {
  allocate(entry: Omit<InFlight, "timer">, arm: (daemonId: number) => InFlight["timer"]): number;
  take(daemonId: number): InFlight | undefined;
  takeAll(): ReadonlyArray<InFlight>;
  clearClient(clientId: string): void;
};

export const createIdMultiplexer = (): IdMultiplexer => {
  let nextId = 1;
  const inFlight = new Map<number, InFlight>();

  return {
    allocate(entry, arm) {
      const daemonId = nextId++;
      inFlight.set(daemonId, { ...entry, timer: arm(daemonId) });
      return daemonId;
    },
    take(daemonId) {
      const e = inFlight.get(daemonId);
      if (!e) return undefined;
      inFlight.delete(daemonId);
      clearTimeout(e.timer);
      return e;
    },
    takeAll() {
      const all = [...inFlight.values()];
      inFlight.clear();
      for (const e of all) clearTimeout(e.timer);
      return all;
    },
    // A disconnected client must not be answered later: dropping its entries also cancels their timeouts.
    clearClient(clientId) {
      for (const [daemonId, e] of inFlight) {
        if (e.clientId !== clientId) continue;
        clearTimeout(e.timer);
        inFlight.delete(daemonId);
      }
    },
  };
};

export type EventRouter = {
  record(clientId: string, sessionId: string): void;
  release(sessionId: string): void;
  getOwner(sessionId: string): string | undefined;
  removeClient(clientId: string): void;
  route(event: WireEvent): string[];
};

export const createEventRouter = (): EventRouter => {
  const owners = new Map<string, string>();
  const clientSessions = new Map<string, Set<string>>();

  return {
    record(clientId, sessionId) {
      const prev = owners.get(sessionId);
      if (prev && prev !== clientId) clientSessions.get(prev)?.delete(sessionId);
      owners.set(sessionId, clientId);
      let s = clientSessions.get(clientId);
      if (!s) { s = new Set(); clientSessions.set(clientId, s); }
      s.add(sessionId);
    },
    release(sessionId) {
      const owner = owners.get(sessionId);
      if (owner) clientSessions.get(owner)?.delete(sessionId);
      owners.delete(sessionId);
    },
    getOwner(sessionId) {
      return owners.get(sessionId);
    },
    removeClient(clientId) {
      const sessions = clientSessions.get(clientId);
      if (sessions) { for (const sid of sessions) owners.delete(sid); }
      clientSessions.delete(clientId);
    },
    route(event) {
      if (event.sessionId) {
        const owner = owners.get(event.sessionId);
        return owner ? [owner] : [];
      }
      return [...clientSessions.keys()];
    },
  };
};

const CONNECT_WAIT_MS = 15_000;

export const createCdpBridge = (): CdpBridge => {
  let ws: WebSocket | null = null;
  let wsUrl: string | null = null;
  const mux = createIdMultiplexer();
  const router = createEventRouter();
  let eventHandler: EventHandler | null = null;
  let closeHandler: CloseHandler | null = null;

  const connectedWaiters: Array<() => void> = [];
  const signalConnected = (): void => {
    for (const w of connectedWaiters.splice(0)) w();
  };

  const waitForConnection = (timeoutMs: number): Promise<void> =>
    new Promise((resolve) => {
      let settled = false;
      const finish = (): void => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve();
      };
      const timer = setTimeout(finish, timeoutMs);
      connectedWaiters.push(finish);
    });

  const onChromeMessage = (raw: string): void => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (!isCdpRawMessage(parsed)) return;
    const msg: CdpRawMessage = parsed;

    if (msg.id !== undefined) {
      const cb = mux.take(msg.id);
      if (!cb) return;
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
          signalConnected();
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
          for (const cb of mux.takeAll()) {
            cb.send(cb.clientId, {
              type: "response",
              id: cb.localId,
              error: { code: -32000, message: "Chrome disconnected" },
            });
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
    mux.takeAll();
    signalConnected();
    if (ws) { try { ws.close(1000, "Shutdown"); } catch {} ws = null; }
    wsUrl = null;
  };

  const handleRequest = async (
    req: WireRequest,
    clientId: string,
    send: SendToClient,
  ): Promise<void> => {
    // Every queued request awaits the same connect signal rather than each spinning its own poll loop.
    if (!ws || ws.readyState !== WebSocket.OPEN) await waitForConnection(CONNECT_WAIT_MS);

    if (!ws || ws.readyState !== WebSocket.OPEN) {
      send(clientId, {
        type: "response",
        id: req.id,
        error: { code: -32000, message: "Chrome not connected" },
      });
      return;
    }

    const isDetach = req.method === "Target.detachFromTarget";
    if (isDetach && req.sessionId) router.release(req.sessionId);

    const daemonId = mux.allocate(
      { clientId, localId: req.id, send, isAttach: req.method === "Target.attachToTarget" },
      (id) =>
        setTimeout(() => {
          mux.take(id);
          send(clientId, {
            type: "response",
            id: req.id,
            error: { code: -32000, message: `Timeout after ${CDP_COMMAND_TIMEOUT_MS}ms: ${req.method}` },
          });
        }, CDP_COMMAND_TIMEOUT_MS),
    );

    const payload: Record<string, unknown> = {
      id: daemonId,
      method: req.method,
      params: req.params ?? {},
    };
    if (req.sessionId) payload["sessionId"] = req.sessionId;

    try {
      ws.send(JSON.stringify(payload));
    } catch (e) {
      mux.take(daemonId);
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
