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
  try { unlinkSync(DAEMON_SOCKET_PATH); } catch {}

  console.log("Starting daemon (IpcServer + CdpBridge)...");
  const ipcServer = createIpcServer();
  const cdpBridge = createCdpBridge();

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


  console.log("\nConnecting pi client (DaemonTransport)...");
  const transport = createDaemonTransport("pi-e2e-test");

  const connectResult = await transport.connect("");
  check(connectResult.success, `Client connect: ${connectResult.success ? "ok" : connectResult.error.message}`);
  check(transport.state() === "open", "Transport state is open");


  let rawRequests: WireRequest[] = [];
  ipcServer.onMessage((msg, client) => {
    if (msg.type === "request") {
      rawRequests.push(msg);
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

  rawRequests.length = 0;
  const res2 = await transport.request("Runtime.evaluate", { expression: "1+1" }, { sessionId: "session-abc" });
  check(res2.success, "Session-scoped request succeeded");
  check(rawRequests[0]?.sessionId === "session-abc", "SessionId forwarded correctly");

  rawRequests.length = 0;
  const [r3a, r3b, r3c] = await Promise.all([
    transport.request("Target.getTargets", {}),
    transport.request("Browser.getVersion", {}),
    transport.request("Page.captureScreenshot", {}),
  ]);
  check(r3a.success && r3b.success && r3c.success, "All 3 parallel requests succeeded");
  check(rawRequests.length === 3, "Server received all 3 requests");

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

  ipcServer.broadcast({
    type: "event",
    method: "Target.targetCreated",
    params: { targetInfo: { type: "page", targetId: "e2e-test-target" } },
  });

  const eventMethod = await eventPromise;
  check(eventMethod === "Target.targetCreated", `Event received: ${eventMethod ?? "TIMEOUT"}`);

  await transport.close();
  check(transport.state() === "closed", "Transport closed");

  await new Promise(r => setTimeout(r, 500));

  const reconnectResult = await transport.connect("");
  check(reconnectResult.success, "Transport reconnected (simulated session restart)");

  const res4 = await transport.request("Target.getTargets", {});
  check(res4.success, "Request after reconnect succeeded");
  check(transport.state() === "open", "Transport state is open after reconnect");

  check(ipcServer.clientCount() === 1, "Server reports 1 connected client");

  await transport.close();
  await new Promise(r => setTimeout(r, 500));
  check(ipcServer.clientCount() === 0, "Server reports 0 clients after disconnect");

  await ipcServer.stop();
  console.log("\nDaemon stopped ✓");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("E2E test failed:", e);
  process.exit(1);
});
