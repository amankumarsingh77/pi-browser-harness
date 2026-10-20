import { isCdpRawMessage } from "../cdp/types";
import type { CdpRawMessage } from "../cdp/types";
import type { WireRequest, WireResponse, WireEvent } from "./protocol";
import { CDP_COMMAND_TIMEOUT_MS, DAEMON_RECONNECT_METHOD } from "./protocol";
import { asString, isRecord } from "../util/guards";
import { type ChromeConnectionDependencies, type ConnectionStatus, createChromeConnection } from "./connection";

// The text a tool sees when the daemon has no Chrome connection to offer; it tells the model
// (and through it the user) whether to wait, to look at Chrome, or to run /browser-setup.
export const describeDisconnected = (status: ConnectionStatus): string => {
  switch (status.state) {
    case "open":
      return "Chrome not connected";
    case "connecting":
      return `Chrome not connected: a connection attempt has been waiting ${Math.round(status.pendingForMs / 1000)}s. `
        + "If Chrome is showing an \"Allow remote debugging\" prompt, accept it; no further prompts will be opened while this attempt is pending.";
    case "cooldown":
      return `Chrome not connected: the last attempt failed (${status.lastFailure}). `
        + `The next automatic attempt is in ${Math.ceil(status.retryInMs / 1000)}s; run /browser-setup to retry now.`;
    case "disconnected":
      return status.lastFailure ? `Chrome not connected: ${status.lastFailure}` : "Chrome not connected";
    case "stopped":
      return "Chrome not connected: the daemon is shutting down";
  }
};

export type SendToClient = (clientId: string, msg: WireResponse | WireEvent) => void;

export type EventHandler = (event: WireEvent, targetClientIds: string[]) => void;

export type CloseHandler = () => void;

export type CdpBridge = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly handleRequest: (req: WireRequest, clientId: string, send: SendToClient) => Promise<void>;
  readonly isAlive: () => boolean;
  // Not used by the daemon itself; test/manual/bridge-test.ts asserts session ownership through it.
  readonly getSessionOwner: (sessionId: string) => string | undefined;
  readonly removeClient: (clientId: string) => void;
  readonly onEvent: (handler: EventHandler) => void;
  // Fires when an established Chrome connection drops; never for an attempt that failed to open.
  readonly onClose: (handler: CloseHandler) => void;
};

export type InFlight = {
  readonly clientId: string;
  readonly localId: number;
  readonly send: SendToClient;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly isAttach: boolean;
  // The Chrome connection the request went out on, so that only its loss fails the request.
  readonly generation: number;
};

// One map, keyed by the daemon-side id: the client that asked, the id it used, and everything needed to answer it.
export type IdMultiplexer = {
  readonly allocate: (entry: Omit<InFlight, "timer">, arm: (daemonId: number) => InFlight["timer"]) => number;
  readonly take: (daemonId: number) => InFlight | undefined;
  // Removes every matching entry and cancels its timeout, so nothing taken can be answered later.
  readonly takeWhere: (pred: (entry: InFlight) => boolean) => ReadonlyArray<InFlight>;
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
    takeWhere(pred) {
      const taken: InFlight[] = [];
      for (const [daemonId, e] of inFlight) {
        if (!pred(e)) continue;
        clearTimeout(e.timer);
        inFlight.delete(daemonId);
        taken.push(e);
      }
      return taken;
    },
  };
};

export type EventRouter = {
  readonly record: (clientId: string, sessionId: string) => void;
  readonly release: (sessionId: string) => void;
  readonly getOwner: (sessionId: string) => string | undefined;
  readonly removeClient: (clientId: string) => void;
  readonly route: (event: WireEvent) => string[];
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

const errorResponse = (id: number, message: string): WireResponse => ({
  type: "response",
  id,
  error: { code: -32000, message },
});

const failAll = (entries: ReadonlyArray<InFlight>, message: string): void => {
  for (const e of entries) e.send(e.clientId, errorResponse(e.localId, message));
};

export const createCdpBridge = (options: ChromeConnectionDependencies = {}): CdpBridge => {
  const mux = createIdMultiplexer();
  const router = createEventRouter();
  let eventHandler: EventHandler | null = null;
  let closeHandler: CloseHandler | null = null;

  const onChromeMessage = (raw: string): void => {
    let parsed: unknown;
    try { parsed = JSON.parse(raw); } catch { return; }
    if (!isCdpRawMessage(parsed)) return;
    const msg: CdpRawMessage = parsed;

    if (msg.id !== undefined) {
      const cb = mux.take(msg.id);
      if (!cb) return;

      if (msg.error) {
        cb.send(cb.clientId, {
          type: "response",
          id: cb.localId,
          error: { code: msg.error.code ?? -1, message: msg.error.message },
        });
        return;
      }
      if (cb.isAttach && isRecord(msg.result)) {
        const sessionId = asString(msg.result["sessionId"]);
        if (sessionId !== undefined) router.record(cb.clientId, sessionId);
      }
      cb.send(cb.clientId, { type: "response", id: cb.localId, result: msg.result });
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

  const connection = createChromeConnection(options, {
    onMessage: onChromeMessage,
    onEnd: (generation, reason) => {
      // Requests that went out on this socket can never be answered now; fail them at once
      // rather than leaving them to the command timeout.
      failAll(mux.takeWhere((e) => e.generation === generation), "Chrome disconnected");
      if (reason === "dropped") closeHandler?.();
    },
  });

  // Kicks off the first attempt without waiting for it: the daemon serves its IPC socket
  // meanwhile, and handleRequest() joins the attempt in flight.
  const start = (): Promise<void> => {
    void connection.start();
    return Promise.resolve();
  };

  const stop = (): Promise<void> => {
    connection.stop();
    failAll(mux.takeWhere(() => true), "Chrome disconnected");
    return Promise.resolve();
  };

  const handleRequest = async (
    req: WireRequest,
    clientId: string,
    send: SendToClient,
  ): Promise<void> => {
    // The one request the daemon answers itself: a human asked for a fresh dial.
    if (req.method === DAEMON_RECONNECT_METHOD) {
      const open = await connection.reconnectNow();
      send(clientId, open
        ? { type: "response", id: req.id, result: { connected: true } }
        : errorResponse(req.id, describeDisconnected(connection.status())));
      return;
    }
    // Connection attempts happen only in response to explicit browser work.
    if (!connection.isOpen() && !(await connection.connect())) {
      send(clientId, errorResponse(req.id, describeDisconnected(connection.status())));
      return;
    }

    // The session being detached travels in params (src/client.ts sends the envelope sessionId as null).
    if (req.method === "Target.detachFromTarget") {
      const sessionId = asString(req.params?.["sessionId"]);
      if (sessionId !== undefined) router.release(sessionId);
    }

    const daemonId = mux.allocate(
      {
        clientId,
        localId: req.id,
        send,
        isAttach: req.method === "Target.attachToTarget",
        generation: connection.generation(),
      },
      (id) =>
        setTimeout(() => {
          mux.take(id);
          send(clientId, errorResponse(req.id, `Timeout after ${CDP_COMMAND_TIMEOUT_MS}ms: ${req.method}`));
        }, CDP_COMMAND_TIMEOUT_MS),
    );

    const payload: Record<string, unknown> = {
      id: daemonId,
      method: req.method,
      params: req.params ?? {},
    };
    if (req.sessionId) payload["sessionId"] = req.sessionId;

    const sent = connection.send(JSON.stringify(payload));
    if (!sent.success) {
      mux.take(daemonId);
      send(clientId, errorResponse(req.id, sent.error));
    }
  };

  return {
    start,
    stop,
    handleRequest,
    isAlive: () => connection.isOpen(),
    getSessionOwner: (sid) => router.getOwner(sid),
    removeClient: (cid) => {
      // A gone client must never be answered: drop its requests silently and release its sessions.
      mux.takeWhere((e) => e.clientId === cid);
      router.removeClient(cid);
    },
    onEvent: (h) => { eventHandler = h; },
    onClose: (h) => { closeHandler = h; },
  };
};
