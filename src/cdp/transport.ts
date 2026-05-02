import WebSocket from "ws";
import { type Result, err, ok } from "../util/result";
import { type CdpError, cdpError } from "./errors";
import { isCdpRawMessage } from "./types";
import type { CdpEvent, CdpRawMessage } from "./types";

const DEFAULT_TIMEOUT_MS = 15_000;

type Pending = {
  readonly resolve: (v: Result<unknown, CdpError>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly method: string;
};

export type CdpTransport = {
  connect(url: string, opts?: { timeoutMs?: number }): Promise<Result<void, CdpError>>;
  close(): Promise<void>;
  request(
    method: string,
    params: Record<string, unknown>,
    opts?: { sessionId?: string | null; timeoutMs?: number },
  ): Promise<Result<unknown, CdpError>>;
  // Returns the current event queue's iterator. After close()+reconnect, callers
  // must re-call events() — the old iterator will have received done:true.
  events(): AsyncIterable<CdpEvent>;
  state(): "open" | "closed" | "connecting";
  onClose(cb: () => void): () => void;
};

export const createCdpTransport = (): CdpTransport => {
  let ws: WebSocket | null = null;
  let nextId = 1;
  const pending = new Map<number, Pending>();
  const closeListeners = new Set<() => void>();

  type EventQueue = {
    readonly push: (e: CdpEvent) => void;
    readonly end: () => void;
    readonly iter: AsyncIterable<CdpEvent>;
  };

  const makeEventQueue = (): EventQueue => {
    const buf: CdpEvent[] = [];
    const waiters: Array<(v: IteratorResult<CdpEvent>) => void> = [];
    let ended = false;
    return {
      push(e) {
        if (ended) return;
        const w = waiters.shift();
        if (w) w({ value: e, done: false });
        else buf.push(e);
      },
      end() {
        ended = true;
        // value: undefined as unknown as CdpEvent is the correct iterator-protocol
        // pattern: when done=true the value field is conventionally undefined but
        // the TS type still requires CdpEvent.
        for (const w of waiters.splice(0)) w({ value: undefined as unknown as CdpEvent, done: true });
      },
      iter: {
        [Symbol.asyncIterator]() {
          return {
            next: (): Promise<IteratorResult<CdpEvent>> =>
              new Promise((resolve) => {
                const next = buf.shift();
                if (next) resolve({ value: next, done: false });
                else if (ended) resolve({ value: undefined as unknown as CdpEvent, done: true });
                else waiters.push(resolve);
              }),
          };
        },
      },
    };
  };

  let queue = makeEventQueue();

  const handleMessage = (raw: string): void => {
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    if (!isCdpRawMessage(parsed)) return;
    const msg: CdpRawMessage = parsed;
    if (msg.id === undefined) {
      if (msg.method) {
        queue.push({
          method: msg.method,
          params: msg.params,
          ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
        });
      }
      return;
    }
    const p = pending.get(msg.id);
    if (!p) return;
    pending.delete(msg.id);
    clearTimeout(p.timer);
    if (msg.error) {
      const kind = msg.error.message.includes("Session with given id not found")
        ? "session_not_found"
        : "remote_error";
      p.resolve(err(cdpError(kind, msg.error.message, p.method)));
      return;
    }
    p.resolve(ok(msg.result));
  };

  const cleanup = (reason: string): void => {
    for (const [, p] of pending) {
      clearTimeout(p.timer);
      p.resolve(err(cdpError("transport_closed", reason, p.method)));
    }
    pending.clear();
    queue.end();
    queue = makeEventQueue();
    for (const cb of closeListeners) cb();
  };

  return {
    connect(url, opts = {}): Promise<Result<void, CdpError>> {
      const timeoutMs = opts.timeoutMs ?? 10_000;
      return new Promise((resolve) => {
        let settled = false;
        const settle = (r: Result<void, CdpError>): void => {
          if (settled) return;
          settled = true;
          resolve(r);
        };
        try {
          ws = new WebSocket(url);
        } catch (e) {
          settle(err(cdpError("transport_closed", e instanceof Error ? e.message : String(e))));
          return;
        }
        const timer = setTimeout(() => {
          ws?.close();
          ws = null;
          settle(err(cdpError("timeout", `CDP WebSocket connection timed out after ${timeoutMs}ms`)));
        }, timeoutMs);
        ws.onopen = () => {
          clearTimeout(timer);
          settle(ok(undefined));
        };
        ws.onmessage = (ev: WebSocket.MessageEvent) => {
          const data = ev.data;
          handleMessage(typeof data === "string" ? data : data.toString());
        };
        ws.onerror = () => {
          clearTimeout(timer);
          settle(err(cdpError("transport_closed", "CDP WebSocket error during connection")));
        };
        ws.onclose = () => {
          clearTimeout(timer);
          ws = null;
          cleanup("WebSocket closed");
          settle(err(cdpError("transport_closed", "CDP WebSocket closed")));
        };
      });
    },
    close(): Promise<void> {
      if (ws) {
        try { ws.close(1000, "Shutdown"); } catch { /* best effort */ }
        ws = null;
      }
      cleanup("close() called");
      return Promise.resolve();
    },
    request(method, params, opts = {}): Promise<Result<unknown, CdpError>> {
      const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
      const sessionId = opts.sessionId ?? null;
      if (!ws || ws.readyState !== WebSocket.OPEN) {
        return Promise.resolve(err(cdpError("transport_closed", "Browser not connected. Is Chrome running?", method)));
      }
      // Bind to a local const so the non-null is guaranteed even across microtasks
      // between the readyState check and the send() call.
      const sock = ws;
      const id = nextId++;
      const payload: Record<string, unknown> = { id, method, params };
      if (sessionId) payload["sessionId"] = sessionId;
      const json = JSON.stringify(payload);
      return new Promise((resolve) => {
        const timer = setTimeout(() => {
          pending.delete(id);
          resolve(err(cdpError("timeout", `CDP timeout after ${timeoutMs}ms: ${method}`, method)));
        }, timeoutMs);
        pending.set(id, { resolve, timer, method });
        try {
          sock.send(json);
        } catch (e) {
          clearTimeout(timer);
          pending.delete(id);
          resolve(err(cdpError("transport_closed", e instanceof Error ? e.message : String(e), method)));
        }
      });
    },
    events(): AsyncIterable<CdpEvent> {
      // Single-consumer: each connection's event stream may be iterated by
      // exactly one for-await loop. Calling events() multiple times returns
      // the same iterable; the second consumer will silently steal events
      // from the first. After a reconnect, the previous iterator is ended
      // and callers must re-call events() to receive new events.
      return queue.iter;
    },
    state(): "open" | "closed" | "connecting" {
      if (!ws) return "closed";
      if (ws.readyState === WebSocket.CONNECTING) return "connecting";
      if (ws.readyState === WebSocket.OPEN) return "open";
      return "closed";
    },
    onClose(cb): () => void {
      closeListeners.add(cb);
      return () => closeListeners.delete(cb);
    },
  };
};
