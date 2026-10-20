import { createServer, type Server, type Socket } from "node:net";
import { readLines } from "./lines";
import { unlinkSync } from "node:fs";
import { destroyQuietly } from "./socket";
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
  readonly stopReading: () => void;
  registered: boolean;
};

export type MessageHandler = (msg: WireMessage, client: ClientSocket) => void;

export type ConnectionHandler = (client: ClientSocket) => void;

export type Disposer = () => void;

export type IpcServerOptions = {
  readonly socketPath?: string;
  readonly maxClients?: number;
};

export type IpcServer = {
  readonly start: () => Promise<void>;
  readonly stop: () => Promise<void>;
  readonly onMessage: (handler: MessageHandler) => Disposer;
  readonly onConnect: (handler: ConnectionHandler) => Disposer;
  // Runs once per registered client when it goes away, whether its socket closed or it sent
  // "deregister". Every registered handler runs; registering is additive, not a replacement.
  readonly onDisconnect: (handler: ConnectionHandler) => Disposer;
  readonly send: (clientId: string, msg: WireMessage) => void;
  readonly broadcast: (msg: WireMessage) => void;
  readonly clientCount: () => number;
  // Every open socket, registered or not; the connection cap counts these.
  readonly socketCount: () => number;
};

const listen = <H>(handlers: Set<H>) => (handler: H): Disposer => {
  handlers.add(handler);
  return () => { handlers.delete(handler); };
};


export const createIpcServer = (options: IpcServerOptions = {}): IpcServer => {
  const socketPath = options.socketPath ?? DAEMON_SOCKET_PATH;
  const maxClients = options.maxClients ?? DAEMON_MAX_CLIENTS;
  let server: Server | null = null;
  // Sockets that have not registered yet, by their temporary id.
  const anonymous = new Map<string, ClientSocket>();
  const clients = new Map<string, ClientSocket>();
  const messageHandlers = new Set<MessageHandler>();
  const connectHandlers = new Set<ConnectionHandler>();
  const disconnectHandlers = new Set<ConnectionHandler>();
  let nextTempId = 1;

  const unlinkSocketFile = (): void => {
    if (process.platform === "win32") return;
    try {
      unlinkSync(socketPath);
    } catch {
      // Nothing to unlink, or no permission: listen() reports the real problem if there is one.
    }
  };

  // A registered client leaves exactly once: either its socket closes or it deregisters first.
  const forget = (client: ClientSocket): void => {
    if (!client.registered) return;
    client.registered = false;
    clients.delete(client.id);
    for (const h of disconnectHandlers) h(client);
  };

  const start = (): Promise<void> =>
    new Promise((resolve, reject) => {
      unlinkSocketFile();

      server = createServer({ pauseOnConnect: false }, (socket: Socket) => {
        if (anonymous.size + clients.size >= maxClients) {
          socket.destroy();
          return;
        }

        const tempId = `anon-${nextTempId++}`;
        const stopReading = readLines(socket, (line) => { onLine(line); });
        const client: ClientSocket = { id: tempId, socket, stopReading, registered: false };

        anonymous.set(tempId, client);

        function onLine(line: string): void {
          const msg = deserialize(line);
          if (!msg) return;

          if (msg.type === "control" && msg.action === "register") {
            if (client.registered) return;
            const clientId = msg.clientId;

            if (clients.has(clientId)) {
              const reply: WireControl = {
                type: "control",
                action: "shutdown",
                reason: `clientId ${clientId} is already connected`,
              };
              // end() flushes the reply before closing; destroy() would race it.
              socket.end(serialize(reply) + "\n");
              return;
            }

            // Mutate in place so the already-captured closure sees the promoted client.
            anonymous.delete(tempId);
            client.id = clientId;
            client.registered = true;
            clients.set(clientId, client);

            const ack: WireControl = { type: "control", action: "registered", clientId };
            socket.write(serialize(ack) + "\n");

            for (const h of connectHandlers) h(client);
            return;
          }

          if (!client.registered) return;

          if (msg.type === "control" && msg.action === "deregister") {
            if (msg.clientId !== client.id) return;
            forget(client);
            socket.end();
            return;
          }

          for (const h of messageHandlers) h(msg, client);
        }

        // A client socket error is always followed by "close", which does the cleanup.
        socket.on("error", () => undefined);

        socket.on("close", () => {
          anonymous.delete(tempId);
          forget(client);
          stopReading();
        });
      });

      server.on("error", (err: NodeJS.ErrnoException) => {
        reject(err);
      });

      server.listen(socketPath, () => {
        resolve();
      });
    });

  const stop = (): Promise<void> =>
    new Promise((resolve) => {
      // Stopping is not a client leaving: no disconnect handler runs for sockets torn down here.
      for (const [, client] of clients) {
        client.registered = false;
        destroyQuietly(client.socket);
      }
      for (const [, client] of anonymous) {
        destroyQuietly(client.socket);
      }
      clients.clear();
      anonymous.clear();

      if (server) {
        server.close(() => {
          unlinkSocketFile();
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
    } catch {
      // The client went away mid-write; its "close" handler forgets it.
    }
  };

  return {
    start,
    stop,
    onMessage: listen(messageHandlers),
    onConnect: listen(connectHandlers),
    onDisconnect: listen(disconnectHandlers),
    send,
    broadcast: (msg) => {
      for (const [clientId] of clients) send(clientId, msg);
    },
    clientCount: () => clients.size,
    socketCount: () => anonymous.size + clients.size,
  };
};
