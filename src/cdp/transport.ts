import WebSocket from "ws";
import { type Result, err, ok } from "../util/result";
import { type CdpError, cdpError } from "./errors";
import { isCdpRawMessage } from "./types";
import type { CdpEvent, CdpRawMessage } from "./types";
import { type Pending, makeEventQueue, makeOnClose, rejectAllPending, sendWithTimeout } from "./event-queue";

const DEFAULT_TIMEOUT_MS = 15_000;

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
    rejectAllPending(pending, reason);
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
          // If onopen already settled the connect promise, this settle is a no-op
          // (guarded by `settled`). cleanup() above still runs unconditionally so
          // pending requests are rejected and the event queue is rotated.
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
      return sendWithTimeout(pending, id, method, timeoutMs, "CDP", () => sock.send(json));
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
    onClose: makeOnClose(closeListeners),
  };
};
