import { createServer, type Server, type Socket } from "node:net";
import { createInterface, type Interface } from "node:readline";
import { unlinkSync } from "node:fs";
import {
  type WireMessage,
  type WireControl,
  deserialize,
  serialize,
  DAEMON_SOCKET_PATH,
  DAEMON_MAX_CLIENTS,
} from "./protocol";

export type ClientSocket = {
  id: string;
  readonly socket: Socket;
  readonly rl: Interface;
  registered: boolean;
};

export type MessageHandler = (msg: WireMessage, client: ClientSocket) => void;

export type ConnectionHandler = (client: ClientSocket) => void;

export type IpcServer = {
  start(): Promise<void>;
  stop(): Promise<void>;
  onMessage(handler: MessageHandler): void;
  onConnect(handler: ConnectionHandler): void;
  onDisconnect(handler: ConnectionHandler): void;
  send(clientId: string, msg: WireMessage): void;
  broadcast(msg: WireMessage): void;
  clientCount(): number;
};

export const createIpcServer = (): IpcServer => {
  let server: Server | null = null;
  const sockets = new Map<string, ClientSocket>();
  const clients = new Map<string, ClientSocket>();
  let messageHandler: MessageHandler | null = null;
  let connectHandler: ConnectionHandler | null = null;
  let disconnectHandler: ConnectionHandler | null = null;
  let nextTempId = 1;

  const start = (): Promise<void> =>
    new Promise((resolve, reject) => {
      try {
        unlinkSync(DAEMON_SOCKET_PATH);
      } catch {}

      server = createServer({ pauseOnConnect: false }, (socket: Socket) => {
        if (clients.size >= DAEMON_MAX_CLIENTS) {
          socket.destroy();
          return;
        }

        const tempId = `anon-${nextTempId++}`;
        const rl = createInterface({ input: socket, crlfDelay: Infinity });
        let currentClient: ClientSocket = { id: tempId, socket, rl, registered: false };

        sockets.set(tempId, currentClient);

        rl.on("line", (line: string) => {
          const msg = deserialize(line);
          if (!msg) return;

          if (msg.type === "control" && msg.action === "register" && !currentClient.registered) {
            const clientId = msg.clientId;
            if (!clientId) return;

            if (clients.has(clientId)) {
              const reply: WireControl = {
                type: "control",
                action: "shutdown",
                reason: `clientId ${clientId} is already connected`,
              };
              socket.write(serialize(reply) + "\n");
              socket.destroy();
              return;
            }

            // Mutate in place so the already-captured closure sees the promoted client.
            sockets.delete(tempId);
            currentClient.id = clientId;
            currentClient.registered = true;
            clients.set(clientId, currentClient);

            const ack: WireControl = { type: "control", action: "registered", clientId };
            socket.write(serialize(ack) + "\n");

            connectHandler?.(currentClient);
            return;
          }

          if (!currentClient.registered) return;

          messageHandler?.(msg, currentClient);
        });

        socket.on("error", () => {});

        socket.on("close", () => {
          const found = clients.get(currentClient.id) ?? sockets.get(tempId);
          if (found) {
            clients.delete(found.id);
            sockets.delete(tempId);
            if (found.registered) {
              disconnectHandler?.(found);
            }
          }
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
      for (const [, client] of clients) {
        try { client.socket.destroy(); } catch {}
      }
      for (const [, client] of sockets) {
        try { client.socket.destroy(); } catch {}
      }
      clients.clear();
      sockets.clear();

      if (server) {
        server.close(() => {
          try { unlinkSync(DAEMON_SOCKET_PATH); } catch {}
          resolve();
        });
      } else {
        resolve();
      }
    });

  const send = (clientId: string, msg: WireMessage): void => {
    const client = clients.get(clientId);
    if (!client) return;
    try {
      client.socket.write(serialize(msg) + "\n");
    } catch {}
  };

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
    send,
    broadcast(msg) {
      for (const [clientId] of clients) send(clientId, msg);
    },
    clientCount: (): number => clients.size,
  };
};
