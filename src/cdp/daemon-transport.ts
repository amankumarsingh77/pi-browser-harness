/**
 * DaemonTransport — CdpTransport backed by a Unix socket to the browser daemon.
 *
 * Satisfies the exact CdpTransport interface so BrowserClient, CdpSession, and
 * all domain tools work without changes. Internally uses newline-delimited JSON
 * over a Unix domain socket instead of a WebSocket to Chrome.
 *
 * References:
 *   - CdpTransport interface: src/cdp/transport.ts
 *   - net.createConnection IPC: https://nodejs.org/docs/latest-v22.x/api/net.html#netcreateconnection
 *   - readline.createInterface: https://nodejs.org/docs/latest-v22.x/api/readline.html#readlinecreateinterfaceoptions
 */

import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { type Result, err, ok } from "../util/result";
import { type CdpError, cdpError } from "../cdp/errors";
import type { CdpTransport } from "../cdp/transport";
import type { CdpEvent } from "../cdp/types";
import { type Pending, makeEventQueue, makeOnClose, rejectAllPending, sendWithTimeout } from "./event-queue";
import {
  DAEMON_SOCKET_PATH,
  type WireRequest,
  type WireControl,
  deserialize,
  serialize,
} from "../daemon/protocol";

// ── Implementation ─────────────────────────────────────────────────────────────

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

  // ── Connect ────────────────────────────────────────────────────────────

  const connect = (_url: string, opts?: { timeoutMs?: number }): Promise<Result<void, CdpError>> => {
    // url is ignored — we always connect to the daemon socket
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

      try {
        socket = createConnection(DAEMON_SOCKET_PATH);
      } catch (e) {
        settle(err(cdpError("transport_closed", e instanceof Error ? e.message : String(e))));
        return;
      }

      const connectTimer = setTimeout(() => {
        cleanup("Connection timeout");
        settle(err(cdpError("timeout", `Daemon connection timed out after ${timeoutMs}ms`)));
      }, timeoutMs);

      socket.on("connect", () => {
        clearTimeout(connectTimer);
        rl = createInterface({ input: socket!, crlfDelay: Infinity });

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
              p.resolve(err(cdpError(
                msg.error.message.includes("Session with given id not found")
                  ? "session_not_found"
                  : "remote_error",
                msg.error.message,
                p.method,
              )));
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

        socket!.on("error", () => {
          // Errors are surfaced via 'close'
        });

        socket!.on("close", () => {
          clearTimeout(connectTimer);
          cleanup("Daemon socket closed");
          // If connect hasn't settled yet, settle with error
          settle(err(cdpError("transport_closed", "Daemon socket closed before registration")));
        });

        // Send registration
        const regMsg: WireControl = { type: "control", action: "register", clientId };
        socket!.write(serialize(regMsg) + "\n");
      });

      socket.on("error", (e: NodeJS.ErrnoException) => {
        clearTimeout(connectTimer);
        const msg = e.code === "ENOENT"
          ? "Daemon not running — socket not found"
          : e.message;
        settle(err(cdpError("transport_closed", msg)));
      });
    });
  };

  // ── Close ──────────────────────────────────────────────────────────────

  const close = async (): Promise<void> => {
    if (registered && socket && !socket.destroyed) {
      const dereg: WireControl = { type: "control", action: "deregister", clientId };
      try { socket.write(serialize(dereg) + "\n"); } catch {}
    }
    cleanup("close() called");
  };

  // ── Request ────────────────────────────────────────────────────────────

  const request = (
    method: string,
    params: Record<string, unknown>,
    opts?: { sessionId?: string | null; timeoutMs?: number },
  ): Promise<Result<unknown, CdpError>> => {
    const timeoutMs = opts?.timeoutMs ?? 15_000;
    const sessionId = opts?.sessionId ?? null;

    if (!socket || socket.destroyed || !registered) {
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

    return sendWithTimeout(pending, id, method, timeoutMs, "Daemon", () => socket!.write(serialize(req) + "\n"));
  };

  // ── Events ─────────────────────────────────────────────────────────────

  const events = (): AsyncIterable<CdpEvent> => queue.iter;

  // ── State ──────────────────────────────────────────────────────────────

  const state = (): "open" | "closed" | "connecting" => {
    if (!socket) return "closed";
    if (!registered) return "connecting";
    if (socket.destroyed) return "closed";
    return "open";
  };

  const onClose = makeOnClose(closeListeners);

  return { connect, close, request, events, state, onClose };
};
