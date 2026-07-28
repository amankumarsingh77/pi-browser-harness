import { createIpcServer } from "./server";
import { createCdpBridge, type SendToClient } from "./bridge";
import { DAEMON_IDLE_TIMEOUT_MS } from "./protocol";

async function main() {
  console.log("[pi-browser-daemon] Starting...");

  const ipcServer = createIpcServer();
  const cdpBridge = createCdpBridge();

  ipcServer.onMessage((msg, client) => {
    if (msg.type !== "request") return;

    const send: SendToClient = (cid, resp) => {
      ipcServer.send(cid, resp);
    };

    cdpBridge.handleRequest(msg, client.id, send);
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
    console.log("[pi-browser-daemon] Chrome disconnected");
    ipcServer.broadcast({
      type: "control",
      action: "shutdown",
      reason: "chrome_disconnected",
    });
  });

  let idleTimer: ReturnType<typeof setTimeout> | null = null;

  const resetIdleTimer = (): void => {
    if (idleTimer) clearTimeout(idleTimer);
    if (ipcServer.clientCount() === 0) {
      idleTimer = setTimeout(() => {
        console.log("[pi-browser-daemon] Idle timeout — no clients for " +
          `${DAEMON_IDLE_TIMEOUT_MS / 60000} minutes. Shutting down.`);
        shutdown();
      }, DAEMON_IDLE_TIMEOUT_MS);
    }
  };

  const cancelIdleTimer = (): void => {
    if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
  };

  ipcServer.onConnect(() => { cancelIdleTimer(); });
  ipcServer.onDisconnect(() => { resetIdleTimer(); });

  try {
    await ipcServer.start();
    console.log("[pi-browser-daemon] IPC server listening");
  } catch (e) {
    console.error("[pi-browser-daemon] Failed to start IPC server:", e);
    process.exit(1);
  }

  await cdpBridge.start();

  resetIdleTimer();

  const shutdown = async () => {
    console.log("[pi-browser-daemon] Shutting down...");
    await cdpBridge.stop();
    await ipcServer.stop();
    process.exit(0);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);
}

main().catch((e) => {
  console.error("[pi-browser-daemon] Fatal:", e);
  process.exit(1);
});
