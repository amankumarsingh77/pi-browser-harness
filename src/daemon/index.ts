import { realpathSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { createIpcServer, type IpcServer } from "./server";
import { createCdpBridge, type CdpBridge, type SendToClient } from "./bridge";
import { DAEMON_IDLE_TIMEOUT_MS } from "./protocol";

export type DaemonLog = {
  readonly info: (message: string) => void;
  readonly error: (message: string, cause?: unknown) => void;
};

export type DaemonDeps = {
  readonly ipcServer?: IpcServer;
  readonly cdpBridge?: CdpBridge;
  readonly idleTimeoutMs?: number;
  // Ends the process once shutdown has released the socket and the Chrome connection.
  readonly exit?: (code: number) => void;
  readonly log?: DaemonLog;
};

export type Daemon = {
  // Listens on the IPC socket, connects to Chrome and arms the idle timer. Resolves once both are up.
  readonly start: () => Promise<void>;
  // Releases Chrome and the socket, then calls `exit(0)`. Idempotent.
  readonly stop: () => Promise<void>;
  readonly idleTimerArmed: () => boolean;
};

const consoleLog: DaemonLog = {
  info: (message) => { console.log(`[pi-browser-daemon] ${message}`); },
  error: (message, cause) => {
    if (cause === undefined) console.error(`[pi-browser-daemon] ${message}`);
    else console.error(`[pi-browser-daemon] ${message}`, cause);
  },
};

// The composition the daemon process runs: request routing, event fan-out, client removal, the
// idle timer and shutdown. Every collaborator is injectable so the wiring can be driven in-process.
export const createDaemon = (deps: DaemonDeps = {}): Daemon => {
  const ipcServer = deps.ipcServer ?? createIpcServer();
  const cdpBridge = deps.cdpBridge ?? createCdpBridge();
  const idleTimeoutMs = deps.idleTimeoutMs ?? DAEMON_IDLE_TIMEOUT_MS;
  const exit = deps.exit ?? ((code: number): void => { process.exit(code); });
  const log = deps.log ?? consoleLog;

  let idleTimer: ReturnType<typeof setTimeout> | null = null;
  let stopping: Promise<void> | null = null;

  const cancelIdleTimer = (): void => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };

  const stop = (): Promise<void> => {
    stopping ??= (async () => {
      log.info("Shutting down...");
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
        log.info(`Idle timeout — no clients for ${idleTimeoutMs / 60000} minutes. Shutting down.`);
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
    log.info("Chrome disconnected");
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
      log.info("IPC server listening");
    } catch (e) {
      log.error("Failed to start IPC server:", e);
      exit(1);
      return;
    }

    await cdpBridge.start();

    resetIdleTimer();
  };

  return { start, stop, idleTimerArmed: () => idleTimer !== null };
};

const samePath = (a: string, b: string): boolean => {
  if (resolve(a) === resolve(b)) return true;
  try {
    return realpathSync(a) === realpathSync(b);
  } catch {
    return false;
  }
};

// True only when this file is the script Node was started with, so importing it from a test or
// another module never launches a daemon.
export const isDaemonEntry = (argv: ReadonlyArray<string> = process.argv, moduleUrl: string = import.meta.url): boolean => {
  const script = argv[1];
  if (script === undefined || script === "") return false;
  return samePath(script, fileURLToPath(moduleUrl));
};

const main = async (): Promise<void> => {
  consoleLog.info("Starting...");
  const daemon = createDaemon();
  process.on("SIGINT", () => { void daemon.stop(); });
  process.on("SIGTERM", () => { void daemon.stop(); });
  await daemon.start();
};

if (isDaemonEntry()) {
  main().catch((e: unknown) => {
    consoleLog.error("Fatal:", e);
    process.exit(1);
  });
}
