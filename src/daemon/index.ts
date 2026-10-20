import { createIpcServer, type IpcServer } from "./server";
import { createCdpBridge, type CdpBridge, type SendToClient } from "./bridge";
import { DAEMON_IDLE_TIMEOUT_MS } from "./protocol";

export type DaemonDeps = {
  readonly ipcServer?: IpcServer;
  readonly cdpBridge?: CdpBridge;
  readonly idleTimeoutMs?: number;
  // Ends the process once shutdown has released the socket and the Chrome connection.
  readonly exit?: (code: number) => void;
  // One line per lifecycle event; defaults to the process's stdout.
  readonly log?: (line: string) => void;
};

export type Daemon = {
  // Listens on the IPC socket, connects to Chrome and arms the idle timer. Resolves once both are up.
  readonly start: () => Promise<void>;
  // Releases Chrome and the socket, then calls `exit(0)`. Idempotent.
  readonly stop: () => Promise<void>;
  readonly idleTimerArmed: () => boolean;
};

export const LOG_PREFIX = "[pi-browser-daemon]";

export const describeError = (e: unknown): string => (e instanceof Error ? (e.stack ?? e.message) : String(e));

// The composition the daemon process runs: request routing, event fan-out, client removal, the
// idle timer and shutdown. Every collaborator is injectable so the wiring can be driven in-process.
// The process entry that starts it lives in ./main.ts, so importing this module never launches a daemon.
export const createDaemon = (deps: DaemonDeps = {}): Daemon => {
  const ipcServer = deps.ipcServer ?? createIpcServer();
  const cdpBridge = deps.cdpBridge ?? createCdpBridge();
  const idleTimeoutMs = deps.idleTimeoutMs ?? DAEMON_IDLE_TIMEOUT_MS;
  const exit = deps.exit ?? ((code: number): void => { process.exit(code); });
  const log = deps.log ?? ((line: string): void => { console.log(`${LOG_PREFIX} ${line}`); });

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping: Promise<void> | null = null;

  const cancelIdleTimer = (): void => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };

  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      log("Shutting down...");
      cancelIdleTimer();
      await cdpBridge.stop();
      await ipcServer.stop();
      exit(0);
    })();
    return stopping;
  };

  const resetIdleTimer = (): void => {
    cancelIdleTimer();
    if (ipcServer.clientCount() === 0) {
      idleTimer = setTimeout(() => {
        idleTimer = null;
        log(`Idle timeout — no clients for ${idleTimeoutMs / 60000} minutes. Shutting down.`);
        void stop();
      }, idleTimeoutMs);
    }
  };

  ipcServer.onMessage((msg, client) => {
    // Control messages (register/deregister) are consumed by the server itself.
    if (msg.type !== "request") return;

    const send: SendToClient = (cid, resp) => {
      ipcServer.send(cid, resp);
    };

    void cdpBridge.handleRequest(msg, client.id, send);
  });

  cdpBridge.onEvent((event, targetClientIds) => {
    for (const cid of targetClientIds) {
      ipcServer.send(cid, event);
    }
  });

  ipcServer.onDisconnect((client) => {
    cdpBridge.removeClient(client.id);
  });

  cdpBridge.onClose(() => {
    log("Chrome disconnected");
    ipcServer.broadcast({
      type: "control",
      action: "shutdown",
      reason: "chrome_disconnected",
    });
  });

  ipcServer.onConnect(() => { cancelIdleTimer(); });
  ipcServer.onDisconnect(() => { resetIdleTimer(); });

  const start = async (): Promise<void> => {
    try {
      await ipcServer.start();
      log("IPC server listening");
    } catch (e) {
      log(`Failed to start IPC server: ${describeError(e)}`);
      exit(1);
      return;
    }

    await cdpBridge.start();

    resetIdleTimer();
  };

  return { start, stop, idleTimerArmed: () => idleTimer !== null };
};
