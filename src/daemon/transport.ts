import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { destroyQuietly } from "./socket";
import { type Result, err, ok } from "../util/result";
import { type CdpError, cdpError, classifyRemoteError } from "../cdp/errors";
import { DEFAULT_TIMEOUT_MS, type CdpTransport } from "../cdp/types";
import type { CdpEvent } from "../cdp/types";
import { type Pending, makeEventQueue, makeOnClose, rejectAllPending, sendWithTimeout } from "./queue";
import {
  DAEMON_SOCKET_PATH,
  type WireRequest,
  type WireControl,
  deserialize,
  serialize,
} from "./protocol";

type ConnectResult = Result<void, CdpError>;

export const createDaemonTransport = (clientId: string, socketPath: string = DAEMON_SOCKET_PATH): CdpTransport => {
  let socket: Socket | null = null;
  let rl: ReturnType<typeof createInterface> | null = null;
  let queue = makeEventQueue();
  const closeListeners = new Set<() => void>();
  const pending = new Map<number, Pending>();
  let registered = false;
  let nextRequestId = 1;
  // The handshake in progress, so that concurrent connect() callers share one socket instead
  // of each opening their own and the later one orphaning the earlier.
  let inFlight: Promise<ConnectResult> | null = null;

  // Tears down `sock` only if it is still the transport's socket: a socket from a superseded
  // attempt is just destroyed, without touching the state that belongs to the current one.
  const cleanup = (sock: Socket, reason: string): void => {
    if (socket !== sock) {
      destroyQuietly(sock);
      return;
    }

    rejectAllPending(pending, reason);
    queue.end();
    queue = makeEventQueue();
    registered = false;

    if (rl) { rl.close(); rl = null; }
    socket = null;
    destroyQuietly(sock);

    for (const cb of closeListeners) cb();
  };

  const handshake = (timeoutMs: number): Promise<ConnectResult> =>
    new Promise((resolve) => {
      let sock: Socket;
      try {
        sock = createConnection(socketPath);
      } catch (e) {
        resolve(err(cdpError("transport_closed", e instanceof Error ? e.message : String(e))));
        return;
      }
      socket = sock;
      // The client is kept connected across sessions on purpose (index.ts session_shutdown), so this
      // socket must not be what keeps the process alive: in `pi -p` it was the last handle standing
      // and pi never exited (#39). In-flight requests hold their own ref'd timers, so nothing a
      // caller is awaiting can be dropped by this.
      sock.unref();

      // The timer is the one ref'd handle for the whole handshake: with the socket unref'd, nothing
      // else stops the process exiting between TCP connect and the daemon's "registered" reply.
      // It is cleared only in settle(), so a daemon that accepts but never registers times out.
      let settled = false;
      const connectTimer = setTimeout(() => {
        cleanup(sock, "Connection timeout");
        settle(err(cdpError("timeout", `Daemon connection timed out after ${timeoutMs}ms`)));
      }, timeoutMs);
      const settle = (r: ConnectResult): void => {
        if (settled) return;
        settled = true;
        clearTimeout(connectTimer);
        resolve(r);
      };

      sock.on("connect", () => {
        const lines = createInterface({ input: sock, crlfDelay: Infinity });
        rl = lines;

        lines.on("line", (line: string) => {
          if (socket !== sock) return;
          const msg = deserialize(line);
          if (!msg) return;

          if (msg.type === "control") {
            if (msg.action === "registered" && msg.clientId === clientId) {
              registered = true;
              settle(ok(undefined));
            } else if (msg.action === "shutdown") {
              cleanup(sock, `Daemon shutting down: ${msg.reason ?? "unknown"}`);
              settle(err(cdpError("transport_closed", `Daemon refused the connection: ${msg.reason ?? "unknown"}`)));
            }
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
          }
        });

        const regMsg: WireControl = { type: "control", action: "register", clientId };
        sock.write(serialize(regMsg) + "\n");
      });

      // Fires before "close" on any failure, so the message it carries wins over the generic one.
      // Tearing down here too means state() reads "closed" as soon as the caller sees the error.
      sock.on("error", (e: NodeJS.ErrnoException) => {
        const msg = e.code === "ENOENT"
          ? "Daemon not running — socket not found"
          : e.message;
        cleanup(sock, msg);
        settle(err(cdpError("transport_closed", msg)));
      });

      sock.on("close", () => {
        cleanup(sock, "Daemon socket closed");
        settle(err(cdpError("transport_closed", "Daemon socket closed before registration")));
      });
    });

  // `_url` is part of CdpTransport but meaningless here: the daemon discovers and owns the
  // Chrome endpoint itself, and this transport always dials the daemon's own socket path.
  const connect = (_url: string, opts?: { timeoutMs?: number }): Promise<ConnectResult> => {
    const timeoutMs = opts?.timeoutMs ?? 10_000;

    if (socket && !socket.destroyed && registered) {
      return Promise.resolve(ok(undefined));
    }
    if (inFlight) return inFlight;

    const attempt = handshake(timeoutMs).then((r) => {
      if (inFlight === attempt) inFlight = null;
      return r;
    });
    inFlight = attempt;
    return attempt;
  };

  const close = (): Promise<void> => {
    const sock = socket;
    if (!sock) return Promise.resolve();
    if (registered && !sock.destroyed) {
      const dereg: WireControl = { type: "control", action: "deregister", clientId };
      try {
        sock.write(serialize(dereg) + "\n");
      } catch {
        // The daemon is already gone; cleanup below drops the socket regardless.
      }
    }
    cleanup(sock, "close() called");
    return Promise.resolve();
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
      ...(sessionId !== null ? { sessionId } : {}),
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
