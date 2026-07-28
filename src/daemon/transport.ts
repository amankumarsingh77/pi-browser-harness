import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { type Result, err, ok } from "../util/result";
import { type CdpError, cdpError, classifyRemoteError } from "../cdp/errors";
import { DEFAULT_TIMEOUT_MS, type CdpTransport } from "../cdp/transport";
import type { CdpEvent } from "../cdp/types";
import { makeEventQueue } from "../cdp/event-queue";
import { type Pending, makeOnClose, rejectAllPending, sendWithTimeout } from "../cdp/pending-requests";
import {
  DAEMON_SOCKET_PATH,
  type WireRequest,
  type WireControl,
  deserialize,
  serialize,
} from "./protocol";

export const createDaemonTransport = (clientId: string): CdpTransport => {
  let socket: Socket | null = null;
  let rl: ReturnType<typeof createInterface> | null = null;
  let queue = makeEventQueue();
  const closeListeners = new Set<() => void>();
  const pending = new Map<number, Pending>();
  let registered = false;
  let nextRequestId = 1;

  const cleanup = (reason: string): void => {
    rejectAllPending(pending, reason);
    queue.end();
    queue = makeEventQueue();
    registered = false;

    if (rl) { rl.close(); rl = null; }
    if (socket) { try { socket.destroy(); } catch {} socket = null; }

    for (const cb of closeListeners) cb();
  };

  const connect = (_url: string, opts?: { timeoutMs?: number }): Promise<Result<void, CdpError>> => {
    const timeoutMs = opts?.timeoutMs ?? 10_000;

    if (socket && !socket.destroyed && registered) {
      return Promise.resolve(ok(undefined));
    }

    return new Promise((resolve) => {
      let settled = false;
      const settle = (r: Result<void, CdpError>): void => {
        if (settled) return;
        settled = true;
        resolve(r);
      };

      let sock: Socket;
      try {
        sock = createConnection(DAEMON_SOCKET_PATH);
      } catch (e) {
        settle(err(cdpError("transport_closed", e instanceof Error ? e.message : String(e))));
        return;
      }
      socket = sock;

      const connectTimer = setTimeout(() => {
        cleanup("Connection timeout");
        settle(err(cdpError("timeout", `Daemon connection timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      sock.on("connect", () => {
        clearTimeout(connectTimer);
        rl = createInterface({ input: sock, crlfDelay: Infinity });

        rl.on("line", (line: string) => {
          const msg = deserialize(line);
          if (!msg) return;

          if (msg.type === "control" && msg.action === "registered" && msg.clientId === clientId) {
            registered = true;
            settle(ok(undefined));
            return;
          }

          if (msg.type === "control" && msg.action === "shutdown") {
            cleanup(`Daemon shutting down: ${msg.reason ?? "unknown"}`);
            return;
          }

          if (!registered) return;

          if (msg.type === "response") {
            const p = pending.get(msg.id);
            if (!p) return;
            pending.delete(msg.id);
            clearTimeout(p.timer);

            if (msg.error) {
              p.resolve(err(cdpError(classifyRemoteError(msg.error.message), msg.error.message, p.method)));
            } else {
              p.resolve(ok(msg.result));
            }
            return;
          }

          if (msg.type === "event") {
            queue.push({
              method: msg.method,
              params: msg.params,
              ...(msg.sessionId !== undefined ? { sessionId: msg.sessionId } : {}),
            });
            return;
          }
        });

        sock.on("error", () => {});

        sock.on("close", () => {
          clearTimeout(connectTimer);
          cleanup("Daemon socket closed");
          settle(err(cdpError("transport_closed", "Daemon socket closed before registration")));
        });

        const regMsg: WireControl = { type: "control", action: "register", clientId };
        sock.write(serialize(regMsg) + "\n");
      });

      sock.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(connectTimer);
        const msg = e.code === "ENOENT"
          ? "Daemon not running — socket not found"
          : e.message;
        settle(err(cdpError("transport_closed", msg)));
      });
    });
  };

  const close = async (): Promise<void> => {
    if (registered && socket && !socket.destroyed) {
      const dereg: WireControl = { type: "control", action: "deregister", clientId };
      try { socket.write(serialize(dereg) + "\n"); } catch {}
    }
    cleanup("close() called");
  };

  const request = (
    method: string,
    params: Record<string, unknown>,
    opts?: { sessionId?: string | null; timeoutMs?: number },
  ): Promise<Result<unknown, CdpError>> => {
    const timeoutMs = opts?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    const sessionId = opts?.sessionId ?? null;

    const sock = socket;
    if (sock === null || sock.destroyed || !registered) {
      return Promise.resolve(err(cdpError("transport_closed", "Daemon not connected", method)));
    }

    const id = nextRequestId++;
    const req: WireRequest = {
      type: "request",
      id,
      method,
      params,
      ...(sessionId !== null && sessionId !== undefined ? { sessionId } : {}),
    };

    return sendWithTimeout(pending, id, method, timeoutMs, "Daemon", () => sock.write(serialize(req) + "\n"));
  };

  const events = (): AsyncIterable<CdpEvent> => queue.iter;

  const state = (): "open" | "closed" | "connecting" => {
    if (!socket) return "closed";
    if (!registered) return "connecting";
    if (socket.destroyed) return "closed";
    return "open";
  };

  const onClose = makeOnClose(closeListeners);

  return { connect, close, request, events, state, onClose };
};
