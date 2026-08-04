import WebSocket from "ws";
import { discoverWsUrl } from "../cdp/discovery";
import { isCdpRawMessage } from "../cdp/types";
import type { CdpRawMessage } from "../cdp/types";
import type { WireRequest, WireResponse, WireEvent } from "./protocol";
import { CDP_CONNECT_TIMEOUT_MS, CDP_COMMAND_TIMEOUT_MS } from "./protocol";
import { asString, isRecord } from "../util/guards";
import type { CdpError } from "../cdp/errors";
import type { Result } from "../util/result";

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

type CdpBridgeDependencies = {
  discoverWsUrl?: () => Promise<Result<string, CdpError>>;
  createWebSocket?: (url: string) => WebSocket;
  connectTimeoutMs?: number;
  onAttemptSettled?: () => void;
};

export const createCdpBridge = (options: CdpBridgeDependencies = {}): CdpBridge => {
  const {
    discoverWsUrl: discoverWsUrlImpl = discoverWsUrl,
    createWebSocket: createWebSocketImpl = (url: string): WebSocket =>
      new WebSocket(url, { perMessageDeflate: false }),
    connectTimeoutMs = CDP_CONNECT_TIMEOUT_MS,
    onAttemptSettled,
  } = options;

  let ws: WebSocket | null = null;
  let wsUrl: string | null = null;
  const mux = createIdMultiplexer();
  const router = createEventRouter();
  let eventHandler: EventHandler | null = null;
  let closeHandler: CloseHandler | null = null;

  // daemonId -> { generation, clientId }: lets a failed attempt reject only its own
  // in-flight requests, and a gone client's entries be dropped without late answers.
  const generations = new Map<number, { generation: number; clientId: string }>();

  let stopped = false;
  let connecting = false;
  let attemptGeneration = 0;
  let activeAttempt = 0;
  let activeSocket: WebSocket | null = null;

  const onChromeMessage = (raw: string): void => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (!isCdpRawMessage(parsed)) return;
    const msg: CdpRawMessage = parsed;

    if (msg.id !== undefined) {
      generations.delete(msg.id);
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

  const rejectCallbacksWhere = (
    pred: (info: { generation: number; clientId: string }) => boolean,
  ): void => {
    for (const [daemonId, info] of generations) {
      if (!pred(info)) continue;
      generations.delete(daemonId);
      const cb = mux.take(daemonId);
      if (!cb) continue;
      cb.send(cb.clientId, {
        type: "response",
        id: cb.localId,
        error: { code: -32000, message: "Chrome disconnected" },
      });
    }
  };

  const rejectAttemptCallbacks = (generation: number): void => {
    rejectCallbacksWhere((info) => info.generation === generation);
  };

  const rejectAllPendingCallbacks = (): void => {
    rejectCallbacksWhere(() => true);
  };

  const closeSocket = (socket: WebSocket): void => {
    try {
      socket.close();
    } catch {}
  };

  const isCurrentAttempt = (generation: number): boolean =>
    generation === activeAttempt && !stopped;

  const isCurrentAttemptSocket = (generation: number, socket: WebSocket): boolean =>
    isCurrentAttempt(generation) && activeSocket === socket;

  const clearActiveAttempt = (generation: number): void => {
    if (activeAttempt === generation) {
      activeAttempt = 0;
      activeSocket = null;
    }
  };

  // On-demand Chrome connection. Attempts happen only from start() and from
  // handleRequest() while disconnected; a failed or disconnected bridge stays
  // disconnected until the next explicit browser demand. No background retry loop.
  const tryConnect = (): void => {
    if (stopped || connecting || (ws && ws.readyState === WebSocket.OPEN)) return;

    const generation = ++attemptGeneration;
    activeAttempt = generation;
    connecting = true;

    const attempt = async (): Promise<void> => {
      let settled = false;
      let sock: WebSocket | null = null;
      let timeout: ReturnType<typeof setTimeout> | null = null;
      let settleAttempt: () => void = () => {};

      const settledPromise = new Promise<void>((resolve) => {
        settleAttempt = (): void => {
          if (settled) return;
          settled = true;
          if (timeout) {
            clearTimeout(timeout);
            timeout = null;
          }
          if (generation === activeAttempt && !stopped) {
            wsUrl = null;
            connecting = false;
          }
          rejectAttemptCallbacks(generation);
          onAttemptSettled?.();
          resolve();
        };
      });

      const clearAttemptTimeout = (): void => {
        if (timeout) {
          clearTimeout(timeout);
          timeout = null;
        }
      };

      const failCurrentAttempt = (notifyClose: boolean): void => {
        clearAttemptTimeout();
        const isCurrent = isCurrentAttempt(generation);
        if (!isCurrent) {
          rejectAttemptCallbacks(generation);
          return;
        }

        clearActiveAttempt(generation);
        if (ws === sock) ws = null;
        wsUrl = null;
        connecting = false;
        if (notifyClose) closeHandler?.();
        settleAttempt();
      };

      timeout = setTimeout(() => {
        if (!isCurrentAttempt(generation) || stopped) {
          failCurrentAttempt(false);
          return;
        }

        if (sock && sock.readyState !== WebSocket.CLOSED) {
          closeSocket(sock);
        }
        failCurrentAttempt(true);
      }, connectTimeoutMs);

      let url = wsUrl;
      if (!url) {
        const d = await discoverWsUrlImpl();
        if (!isCurrentAttempt(generation) || stopped) {
          failCurrentAttempt(false);
          return;
        }
        if (!d.success) {
          failCurrentAttempt(false);
          return;
        }
        url = d.data;
      }

      if (!isCurrentAttempt(generation) || stopped) {
        failCurrentAttempt(false);
        return;
      }

      try {
        sock = createWebSocketImpl(url);
      } catch {
        failCurrentAttempt(false);
        return;
      }

      if (!isCurrentAttempt(generation) || stopped) {
        closeSocket(sock);
        failCurrentAttempt(false);
        return;
      }

      wsUrl = url;
      activeSocket = sock;

      const onOpen = (): void => {
        if (!sock || !isCurrentAttemptSocket(generation, sock)) {
          clearAttemptTimeout();
          if (sock && sock.readyState !== WebSocket.CLOSED) {
            closeSocket(sock);
          }
          failCurrentAttempt(false);
          return;
        }

        clearAttemptTimeout();
        ws = sock;
        try {
          ws.send(JSON.stringify({ id: 0, method: "Target.setDiscoverTargets", params: { discover: true } }));
        } catch {
          failCurrentAttempt(true);
          if (sock.readyState !== WebSocket.CLOSED) {
            closeSocket(sock);
          }
          return;
        }
        console.log("[pi-browser-daemon] Connected to Chrome ✓");
        settleAttempt();
      };

      const onMessage = (data: WebSocket.Data): void => {
        if (!sock || !isCurrentAttemptSocket(generation, sock)) return;
        onChromeMessage(typeof data === "string" ? data : data.toString());
      };

      const onError = (): void => {
        clearAttemptTimeout();
        const notifyClose = !!sock && isCurrentAttemptSocket(generation, sock);
        failCurrentAttempt(notifyClose);
        if (sock && sock.readyState !== WebSocket.CLOSED) {
          closeSocket(sock);
        }
      };

      const onClose = (): void => {
        clearAttemptTimeout();
        const notifyClose = !!sock && isCurrentAttemptSocket(generation, sock);
        failCurrentAttempt(notifyClose);
      };

      sock.on("open", onOpen);
      sock.on("message", onMessage);
      sock.on("error", onError);
      sock.on("close", onClose);

      // The promise must always settle even on constructor errors.
      await settledPromise;
    };

    attempt().catch(() => {
      if (isCurrentAttempt(generation)) {
        connecting = false;
      }
    });
  };

  const start = async (): Promise<void> => {
    stopped = false;
    tryConnect();
  };

  const stop = async (): Promise<void> => {
    stopped = true;
    attemptGeneration += 1;
    activeAttempt = 0;
    activeSocket = null;
    connecting = false;
    rejectAllPendingCallbacks();
    if (ws) {
      try {
        ws.close(1000, "Shutdown");
      } catch {}
      ws = null;
    }
    wsUrl = null;
  };

  const waitForConnection = async (): Promise<boolean> => {
    const deadline = Date.now() + connectTimeoutMs;
    while (connecting && Date.now() < deadline) {
      if (ws && ws.readyState === WebSocket.OPEN) return true;
      await new Promise((r) => setTimeout(r, 5));
    }
    return ws !== null && ws.readyState === WebSocket.OPEN;
  };

  const handleRequest = async (
    req: WireRequest,
    clientId: string,
    send: SendToClient,
  ): Promise<void> => {
    let activeSocket = ws;
    if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
      // Connection attempts happen only in response to explicit browser work.
      tryConnect();
      const ready = await waitForConnection();
      if (!ready) {
        send(clientId, {
          type: "response",
          id: req.id,
          error: { code: -32000, message: "Chrome not connected" },
        });
        return;
      }
    }

    activeSocket = ws;
    if (!activeSocket || activeSocket.readyState !== WebSocket.OPEN) {
      send(clientId, {
        type: "response",
        id: req.id,
        error: { code: -32000, message: "Chrome not connected" },
      });
      return;
    }

    const isDetach = req.method === "Target.detachFromTarget";
    if (isDetach && req.sessionId) router.release(req.sessionId);

    const isAttach = req.method === "Target.attachToTarget";

    const daemonId = mux.allocate(
      { clientId, localId: req.id, send, isAttach },
      (id) =>
        setTimeout(() => {
          mux.take(id);
          generations.delete(id);
          send(clientId, {
            type: "response",
            id: req.id,
            error: { code: -32000, message: `Timeout after ${CDP_COMMAND_TIMEOUT_MS}ms: ${req.method}` },
          });
        }, CDP_COMMAND_TIMEOUT_MS),
    );
    generations.set(daemonId, { generation: attemptGeneration, clientId });

    const payload: Record<string, unknown> = {
      id: daemonId,
      method: req.method,
      params: req.params ?? {},
    };
    if (req.sessionId) payload["sessionId"] = req.sessionId;

    try {
      activeSocket.send(JSON.stringify(payload));
    } catch (e) {
      mux.take(daemonId);
      generations.delete(daemonId);
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
    removeClient: (cid) => {
      rejectCallbacksWhere((info) => info.clientId === cid);
      mux.clearClient(cid);
      router.removeClient(cid);
    },
    onEvent: (h) => { eventHandler = h; },
    onClose: (h) => { closeHandler = h; },
  };
};
