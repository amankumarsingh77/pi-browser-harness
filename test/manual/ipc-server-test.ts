import { createConnection } from "node:net";
import { createInterface } from "node:readline";
import { createIpcServer } from "../../src/daemon/server";
import { DAEMON_SOCKET_PATH } from "../../src/daemon/protocol";
import type { WireEvent, WireMessage } from "../../src/daemon/protocol";

const TEST_CLIENT_ID = "pi-test-001";

async function main() {
  let passed = 0;
  let failed = 0;
  const check = (cond: boolean, label: string) => {
    if (cond) { passed++; console.log(`  ✓ ${label}`); }
    else { failed++; console.error(`  ✗ ${label}`); }
  };

  console.log("Starting IpcServer...");
  const server = createIpcServer();

  const receivedByServer: WireMessage[] = [];
  let connectCount = 0;
  let disconnectCount = 0;

  server.onMessage((msg) => { receivedByServer.push(msg); });
  server.onConnect(() => { connectCount++; });
  server.onDisconnect(() => { disconnectCount++; });

  await server.start();
  console.log("Server started ✓");

  console.log("\nConnecting client...");
  const socket = createConnection(DAEMON_SOCKET_PATH);
  const rl = createInterface({ input: socket, crlfDelay: Infinity });

  const receivedByClient: WireMessage[] = [];
  rl.on("line", (line) => {
    try { receivedByClient.push(JSON.parse(line)); } catch {}
  });

  await new Promise<void>((resolve) => socket.on("connect", resolve));
  console.log("Client connected ✓");

  socket.write(JSON.stringify({ type: "control", action: "register", clientId: TEST_CLIENT_ID }) + "\n");
  await sleep(200);

  const ack = receivedByClient.find((m: any) => m.type === "control" && m.action === "registered");
  check(ack != null, "Registration acknowledged");
  check(connectCount === 1, "Connect handler fired");

  receivedByServer.length = 0;
  const testRequest = { type: "request", id: 1, method: "Page.navigate", params: { url: "https://example.com" } };
  socket.write(JSON.stringify(testRequest) + "\n");
  await sleep(200);

  const received = receivedByServer.find((m: any) => m.type === "request" && m.id === 1);
  check(received != null, "Server received request from client");
  check((received as any)?.method === "Page.navigate", "Method matches");

  receivedByClient.length = 0;
  server.send(TEST_CLIENT_ID, { type: "response", id: 1, result: { frameId: "xyz" } });
  await sleep(200);

  const response = receivedByClient.find((m: any) => m.type === "response" && m.id === 1);
  check(response != null, "Client received response from server");

  receivedByClient.length = 0;
  const broadcastMsg: WireEvent = {
    type: "event",
    method: "Target.targetCreated",
    params: { targetInfo: { type: "page" } },
  };
  server.broadcast(broadcastMsg);
  await sleep(200);

  check(receivedByClient.length === 1, "Client received broadcast");
  const bc = receivedByClient[0] as any;
  check(bc?.method === "Target.targetCreated", "Broadcast content matches");

  socket.destroy();
  await sleep(500);

  check(disconnectCount === 1, "Disconnect handler fired");
  check(server.clientCount() === 0, "Client count is 0 after disconnect");

  const socket2 = createConnection(DAEMON_SOCKET_PATH);
  await new Promise<void>((resolve) => socket2.on("connect", resolve));

  socket2.write(JSON.stringify({ type: "control", action: "register", clientId: TEST_CLIENT_ID }) + "\n");
  await sleep(200);
  check(server.clientCount() === 1, "Re-registration works after disconnect");
  socket2.destroy();
  socket2.on("error", () => {}); // suppress EPIPE from server-side cleanup
  await sleep(300);

  const testSockets: ReturnType<typeof createConnection>[] = [];
  for (let i = 0; i < 20; i++) {
    const s = createConnection(DAEMON_SOCKET_PATH);
    s.on("error", () => {});
    testSockets.push(s);
    await new Promise<void>((resolve) => s.on("connect", resolve));
    try { s.write(JSON.stringify({ type: "control", action: "register", clientId: `pi-test-max-${i}` }) + "\n"); } catch {}
    await sleep(20);
  }
  await sleep(300);
  check(server.clientCount() <= 16, "Max client enforcement works");
  for (const s of testSockets) {
    try { s.destroy(); } catch {}
    s.removeAllListeners();
  }

  console.log(`\nCleaning up...`);
  await server.stop();
  console.log("Server stopped ✓");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
