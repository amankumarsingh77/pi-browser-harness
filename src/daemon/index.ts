/**
 * Browser daemon entry point — standalone long-lived process.
 *
 * Owns a single persistent WebSocket to Chrome. Exposes a Unix domain socket
 * for pi instances to connect through. One Allow dialog ever (per Chrome
 * lifetime), zero repeated prompts.
 *
 * Run: npx tsx src/daemon/index.ts
 */

import { createIpcServer } from "./server";
import { createCdpBridge, type SendToClient } from "./bridge";
import { DAEMON_IDLE_TIMEOUT_MS } from "./protocol";

async function main() {
  console.log("[pi-browser-daemon] Starting...");

  const ipcServer = createIpcServer();
  const cdpBridge = createCdpBridge();

  // ── Wire IpcServer → CdpBridge ─────────────────────────────────────────

  // When a pi client sends a CDP request, proxy it through the bridge to Chrome.
  ipcServer.onMessage((msg, client) => {
    if (msg.type !== "request") return;

    const send: SendToClient = (cid, resp) => {
      ipcServer.send(cid, resp);
    };

    cdpBridge.handleRequest(msg, client.id, send);
  });

  // When Chrome sends an event, route it to the correct pi client(s).
  cdpBridge.onEvent((event, targetClientIds) => {
    for (const cid of targetClientIds) {
      ipcServer.send(cid, event);
    }
  });

  // When a client disconnects, clean up its CDP state.
  ipcServer.onDisconnect((client) => {
    cdpBridge.removeClient(client.id);
  });

  // When Chrome disconnects, notify all clients.
  cdpBridge.onClose(() => {
    console.log("[pi-browser-daemon] Chrome disconnected");
    ipcServer.broadcast({
      type: "control",
      action: "shutdown",
      reason: "chrome_disconnected",
    });
  });

  // ── Idle timeout ───────────────────────────────────────────────────────

  // The daemon exits after DAEMON_IDLE_TIMEOUT_MS with zero connected clients.
  // This prevents zombie processes when pi sessions end and never reconnect.
  // The timeout resets whenever a client connects.
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

  // ── Start ──────────────────────────────────────────────────────────────

  try {
    await ipcServer.start();
    console.log("[pi-browser-daemon] IPC server listening");
  } catch (e) {
    console.error("[pi-browser-daemon] Failed to start IPC server:", e);
    process.exit(1);
  }

  // Connect to Chrome (auto-retries with backoff in the background).
  // The daemon is ready immediately — Chrome may connect later.
  await cdpBridge.start();

  // Start the idle timer (no clients yet at startup).
  resetIdleTimer();

  // ── Graceful shutdown ──────────────────────────────────────────────────

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
