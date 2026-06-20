/**
 * End-to-end integration test: full daemon pipeline.
 *
 * Starts the daemon (IpcServer + CdpBridge), connects via DaemonTransport,
 * exercises the full CDP request/response/event lifecycle.
 *
 * Run: npx tsx test/manual/e2e-test.ts
 */
import { createIpcServer } from "../../src/daemon/server";
import { createCdpBridge, type SendToClient } from "../../src/daemon/bridge";
import { createDaemonTransport } from "../../src/cdp/daemon-transport";
import { DAEMON_SOCKET_PATH } from "../../src/daemon/protocol";
import type { WireRequest } from "../../src/daemon/protocol";
import { unlinkSync } from "node:fs";

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
};

async function main() {
  // Clean up stale socket
  try { unlinkSync(DAEMON_SOCKET_PATH); } catch {}

  // ── Start daemon ───────────────────────────────────────────────────────
  console.log("Starting daemon (IpcServer + CdpBridge)...");
  const ipcServer = createIpcServer();
  const cdpBridge = createCdpBridge();

  // Wire IpcServer ↔ CdpBridge
  ipcServer.onMessage((msg, client) => {
    if (msg.type !== "request") return;
    const send: SendToClient = (cid, resp) => ipcServer.send(cid, resp);
    cdpBridge.handleRequest(msg, client.id, send);
  });

  cdpBridge.onEvent((event, targetClientIds) => {
    for (const cid of targetClientIds) ipcServer.send(cid, event);
  });

  ipcServer.onDisconnect((client) => cdpBridge.removeClient(client.id));

  await ipcServer.start();
  console.log("Daemon started ✓");

  // The bridge will try to connect to Chrome — might fail, that's ok for
  // this test. We'll simulate CDP responses from the server side.

  // ── Connect pi client via DaemonTransport ──────────────────────────────
  console.log("\nConnecting pi client (DaemonTransport)...");
  const transport = createDaemonTransport("pi-e2e-test");

  const connectResult = await transport.connect("");
  check(connectResult.success, `Client connect: ${connectResult.success ? "ok" : connectResult.error.message}`);
  check(transport.state() === "open", "Transport state is open");

  // ── Test 1: Request → simulated CDP response ───────────────────────────
  // The IpcServer's onMessage handler forwards requests to the bridge.
  // The bridge tries to send to Chrome (which may be down). For this test,
  // we intercept at the IpcServer level and simulate CDP responses.

  // Override the message handler to simulate CDP responses directly.
  let rawRequests: WireRequest[] = [];
  ipcServer.onMessage((msg, client) => {
    if (msg.type === "request") {
      rawRequests.push(msg);
      // Simulate a CDP success response
      ipcServer.send(client.id, {
        type: "response",
        id: msg.id,
        result: { simulated: true, method: msg.method },
      });
    }
  });

  const res1 = await transport.request("Page.navigate", { url: "https://example.com" });
  check(res1.success, "CDP request succeeded");
  if (res1.success) {
    const d = res1.data as any;
    check(d?.simulated === true, "Response contains simulated flag");
    check(d?.method === "Page.navigate", "Response echoes method");
  }
  check(rawRequests.length === 1, "Server received exactly 1 request");
  check(rawRequests[0]!.method === "Page.navigate", "Correct method forwarded");

  // ── Test 2: Request with sessionId ─────────────────────────────────────
  rawRequests.length = 0;
  const res2 = await transport.request("Runtime.evaluate", { expression: "1+1" }, { sessionId: "session-abc" });
  check(res2.success, "Session-scoped request succeeded");
  check(rawRequests[0]?.sessionId === "session-abc", "SessionId forwarded correctly");

  // ── Test 3: Multiple parallel requests ─────────────────────────────────
  rawRequests.length = 0;
  const [r3a, r3b, r3c] = await Promise.all([
    transport.request("Target.getTargets", {}),
    transport.request("Browser.getVersion", {}),
    transport.request("Page.captureScreenshot", {}),
  ]);
  check(r3a.success && r3b.success && r3c.success, "All 3 parallel requests succeeded");
  check(rawRequests.length === 3, "Server received all 3 requests");

  // ── Test 4: Events ─────────────────────────────────────────────────────
  const eventPromise = new Promise<string | null>((resolve) => {
    const timeout = setTimeout(() => resolve(null), 2000);
    (async () => {
      for await (const evt of transport.events()) {
        clearTimeout(timeout);
        resolve(evt.method);
        break;
      }
    })();
  });

  // Simulate a CDP event broadcast from the daemon
  ipcServer.broadcast({
    type: "event",
    method: "Target.targetCreated",
    params: { targetInfo: { type: "page", targetId: "e2e-test-target" } },
  });

  const eventMethod = await eventPromise;
  check(eventMethod === "Target.targetCreated", `Event received: ${eventMethod ?? "TIMEOUT"}`);

  // ── Test 5: Session persistence (detach simulation) ────────────────────
  // Simulate a session shutdown: close the transport, then reconnect.
  // The transport.close() sends deregister, server cleans up.
  await transport.close();
  check(transport.state() === "closed", "Transport closed");

  // Small delay for server cleanup
  await new Promise(r => setTimeout(r, 500));

  // Reconnect — simulates next pi session
  const reconnectResult = await transport.connect("");
  check(reconnectResult.success, "Transport reconnected (simulated session restart)");

  // Send a request through the reconnected transport
  const res4 = await transport.request("Target.getTargets", {});
  check(res4.success, "Request after reconnect succeeded");
  check(transport.state() === "open", "Transport state is open after reconnect");

  // ── Test 6: Server-side client count ───────────────────────────────────
  check(ipcServer.clientCount() === 1, "Server reports 1 connected client");

  // ── Test 7: Client disconnect cleanup ──────────────────────────────────
  await transport.close();
  await new Promise(r => setTimeout(r, 500));
  check(ipcServer.clientCount() === 0, "Server reports 0 clients after disconnect");

  // ── Cleanup ────────────────────────────────────────────────────────────
  await ipcServer.stop();
  console.log("\nDaemon stopped ✓");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E test failed:", e);
  process.exit(1);
});
