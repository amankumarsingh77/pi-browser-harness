/**
 * IpcServer — Unix socket server for daemon ↔ pi client communication.
 *
 * Accepts multiple concurrent pi client connections over a Unix domain
 * stream socket. Uses newline-delimited JSON framing (one WireMessage per
 * line). Clients are anonymous until they send a control.register message.
 *
 * References:
 *   - net.createServer: https://nodejs.org/docs/latest-v22.x/api/net.html#netcreateserveroptions-connectionlistener
 *   - server.listen(path): https://nodejs.org/docs/latest-v22.x/api/net.html#serverlistenpath-backlog-callback
 *   - readline.createInterface: https://nodejs.org/docs/latest-v22.x/api/readline.html#readlinecreateinterfaceoptions
 */

import { createServer, type Server, type Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import { unlinkSync } from "node:fs";
import {
  type WireMessage,
  type WireControl,
  isWireMessage,
  DAEMON_SOCKET_PATH,
  DAEMON_MAX_CLIENTS,
  DAEMON_STALE_SOCKET_CLEANUP,
} from "./protocol";

// ── Types ──────────────────────────────────────────────────────────────────────

/** A connected pi client with its socket and readline interface. */
export type ClientSocket = {
  /** Client namespace (set after registration). */
  id: string;
  readonly socket: Socket;
  readonly rl: Interface;
  /** True once a valid control.register message has been received. */
  registered: boolean;
};

/** Handler called for every valid WireMessage from any client. */
export type MessageHandler = (msg: WireMessage, client: ClientSocket) => void;

/** Handler called when a client connects or disconnects. */
export type ConnectionHandler = (client: ClientSocket) => void;

export type IpcServer = {
  /** Start listening on the Unix socket. Resolves when the server is ready. */
  start(): Promise<void>;
  /** Close the server and all client connections. Resolves when cleaned up. */
  stop(): Promise<void>;
  /** Register a handler for incoming WireMessages from any client. */
  onMessage(handler: MessageHandler): void;
  /** Register a handler for client connect events. */
  onConnect(handler: ConnectionHandler): void;
  /** Register a handler for client disconnect events. */
  onDisconnect(handler: ConnectionHandler): void;
  /** Send a WireMessage to a specific client by clientId. No-op if client not found. */
  send(clientId: string, msg: WireMessage): void;
  /** Send a WireMessage to all connected (registered) clients. */
  broadcast(msg: WireMessage): void;
  /** Force-disconnect a client by clientId. */
  disconnectClient(clientId: string): void;
  /** All currently connected clients (by clientId). */
  clients(): ReadonlyMap<string, ClientSocket>;
  /** Number of connected clients. */
  clientCount(): number;
};

// ── Implementation ─────────────────────────────────────────────────────────────

export const createIpcServer = (): IpcServer => {
  let server: Server | null = null;
  // Anonymous temp-id → ClientSocket. Temp ids are assigned before registration.
  const sockets = new Map<string, ClientSocket>();
  // clientId → ClientSocket (only registered clients).
  const clients = new Map<string, ClientSocket>();
  let messageHandler: MessageHandler | null = null;
  let connectHandler: ConnectionHandler | null = null;
  let disconnectHandler: ConnectionHandler | null = null;
  let nextTempId = 1;

  const start = (): Promise<void> =>
    new Promise((resolve, reject) => {
      // Clean up stale socket file from a previous crashed daemon.
      if (DAEMON_STALE_SOCKET_CLEANUP) {
        try {
          unlinkSync(DAEMON_SOCKET_PATH);
        } catch {
          // ENOENT is expected — no stale socket to clean.
        }
      }

      server = createServer({ pauseOnConnect: false }, (socket: Socket) => {
        // Reject if at capacity (check registered clients only).
        if (clients.size >= DAEMON_MAX_CLIENTS) {
          socket.destroy();
          return;
        }

        const tempId = `anon-${nextTempId++}`;
        const rl = createInterface({ input: socket, crlfDelay: Infinity });
        let currentClient: ClientSocket = { id: tempId, socket, rl, registered: false };

        sockets.set(tempId, currentClient);

        // Buffer for partial lines. readline handles line splitting, but
        // we store a reference in case we need it for diagnostics.
        let lineCount = 0;

        rl.on("line", (line: string) => {
          lineCount++;
          let msg: WireMessage | null;
          try {
            const parsed: unknown = JSON.parse(line);
            if (!isWireMessage(parsed)) return;
            msg = parsed;
          } catch {
            // Malformed JSON — ignore silently, don't crash the daemon.
            return;
          }

          // Handle registration before forwarding to the general handler.
          if (msg.type === "control" && msg.action === "register" && !currentClient.registered) {
            const clientId = msg.clientId;
            if (!clientId) return;

            // If a client with this id is already connected, reject.
            if (clients.has(clientId)) {
              const reply: WireControl = {
                type: "control",
                action: "shutdown",
                reason: `clientId ${clientId} is already connected`,
              };
              socket.write(JSON.stringify(reply) + "\n");
              socket.destroy();
              return;
            }

            // Promote from anonymous to registered — mutate in place so the
            // closure captures the updated client reference.
            sockets.delete(tempId);
            currentClient.id = clientId;
            currentClient.registered = true;
            clients.set(clientId, currentClient);

            // Acknowledge registration.
            const ack: WireControl = { type: "control", action: "registered", clientId };
            socket.write(JSON.stringify(ack) + "\n");

            connectHandler?.(currentClient);
            return;
          }

          // Require registration for non-control messages.
          if (!currentClient.registered) return;

          // Forward to the general handler.
          messageHandler?.(msg, currentClient);
        });

        socket.on("error", () => {
          // Socket errors (ECONNRESET, etc.) are handled by the 'close' event.
        });

        socket.on("close", () => {
          // Clean up whichever map the client is in.
          const found = clients.get(currentClient.id) ?? sockets.get(tempId);
          if (found) {
            clients.delete(found.id);
            sockets.delete(tempId);
            // Notify if this was a registered client.
            if (found.registered) {
              disconnectHandler?.(found);
            }
          }
          // Clean up readline to prevent memory leaks.
          rl.close();
        });
      });

      server.on("error", (err: NodeJS.ErrnoException) => {
        reject(err);
      });

      server.listen(DAEMON_SOCKET_PATH, () => {
        resolve();
      });
    });

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      // Close all client sockets.
      for (const [, client] of clients) {
        try { client.socket.destroy(); } catch { /* best-effort */ }
      }
      for (const [, client] of sockets) {
        try { client.socket.destroy(); } catch { /* best-effort */ }
      }
      clients.clear();
      sockets.clear();

      if (server) {
        server.close(() => {
          // Clean up the socket file.
          try { unlinkSync(DAEMON_SOCKET_PATH); } catch { /* ENOENT ok */ }
          resolve();
        });
      } else {
        resolve();
      }
    });

  return {
    start,
    stop,
    onMessage(handler) {
      messageHandler = handler;
    },
    onConnect(handler) {
      connectHandler = handler;
    },
    onDisconnect(handler) {
      disconnectHandler = handler;
    },
    send(clientId, msg) {
      const client = clients.get(clientId);
      if (!client) return;
      try {
        client.socket.write(JSON.stringify(msg) + "\n");
      } catch {
        // Socket write error — the close handler will clean up.
      }
    },
    broadcast(msg) {
      for (const [clientId] of clients) {
        this.send(clientId, msg);
      }
    },
    disconnectClient(clientId) {
      const client = clients.get(clientId);
      if (!client) return;
      client.socket.destroy();
    },
    clients: (): ReadonlyMap<string, ClientSocket> => clients,
    clientCount: (): number => clients.size,
  };
};
