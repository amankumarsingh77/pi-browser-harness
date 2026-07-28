import { createIpcServer } from "../../src/daemon/server";
import { createDaemonTransport } from "../../src/cdp/daemon-transport";
import { DAEMON_SOCKET_PATH } from "../../src/daemon/protocol";
import type { WireMessage } from "../../src/daemon/protocol";
import { unlinkSync } from "node:fs";

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
};

async function main() {
  try { unlinkSync(DAEMON_SOCKET_PATH); } catch {}

  console.log("Starting IpcServer...");
  const server = createIpcServer();

  server.onMessage((msg, client) => {
    if (msg.type === "request") {
      const reply: WireMessage = {
        type: "response",
        id: msg.id,
        result: { fakeResult: true, method: msg.method },
      };
      server.send(client.id, reply);
    }
  });

  await server.start();
  console.log("Server started ✓");

  const transport = createDaemonTransport("pi-test-transport");

  const connResult = await transport.connect("");
  check(connResult.success, `Connect: ${connResult.success ? "ok" : connResult.error.message}`);
  check(transport.state() === "open", `State is "open" (actual: "${transport.state()}")`);

  const reqResult = await transport.request("Page.navigate", { url: "https://example.com" });
  check(reqResult.success, `Request succeeded: ${reqResult.success}`);
  if (reqResult.success) {
    const data = reqResult.data as any;
    check(data?.fakeResult === true, "Response has fakeResult: true");
    check(data?.method === "Page.navigate", "Response echoes method");
  }

  const req2 = await transport.request("Runtime.evaluate", { expression: "1+1" }, { sessionId: "abc123" });
  check(req2.success, "Request with sessionId succeeded");

  const eventPromise = new Promise<boolean>((resolve) => {
    const timeout = setTimeout(() => resolve(false), 2000);
    (async () => {
      for await (const evt of transport.events()) {
        clearTimeout(timeout);
        resolve(evt.method === "Target.targetCreated");
        break;
      }
    })();
  });

  server.broadcast({
    type: "event",
    method: "Target.targetCreated",
    params: { targetInfo: { type: "page", targetId: "test-123" } },
  });

  const gotEvent = await eventPromise;
  check(gotEvent, "Event received via transport.events()");

  let closeFired = false;
  transport.onClose(() => { closeFired = true; });

  await transport.close();
  check(transport.state() === "closed", "State is closed after close()");
  check(closeFired, "onClose handler fired");

  await new Promise(r => setTimeout(r, 500));
  const reconnectResult = await transport.connect("");
  check(reconnectResult.success, `Reconnect: ${reconnectResult.success ? "ok" : reconnectResult.error.message}`);

  const req3 = await transport.request("Browser.getVersion", {});
  check(req3.success, "Request after reconnect succeeded");

  await transport.close();
  await server.stop();
  console.log("Cleanup complete ✓");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
