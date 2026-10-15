// Connects a daemon transport to a fake daemon that lives in this same process, with every handle
// the fake owns unref'd. The only thing that can keep this process alive afterwards is the
// transport's own socket, so "does the process exit on its own" is the behavior under test.
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { createDaemonTransport } from "../../../src/daemon/transport";
import { deserialize, serialize } from "../../../src/daemon/protocol";

const socketPath = process.argv[2];
if (!socketPath) throw new Error("usage: fixture <socketPath>");
const ackDelayMs = Number(process.argv[3] ?? "0");

const server = createServer((conn) => {
  conn.unref();
  const rl = createInterface({ input: conn, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const msg = deserialize(line);
    if (msg?.type === "control" && msg.action === "register" && msg.clientId !== undefined) {
      const clientId = msg.clientId;
      const acknowledge = (): void => {
        conn.write(serialize({ type: "control", action: "registered", clientId }) + "\n");
      };
      if (ackDelayMs > 0) {
        const timer = setTimeout(acknowledge, ackDelayMs);
        timer.unref();
      } else {
        acknowledge();
      }
    }
  });
});
server.unref();
server.listen(socketPath, async () => {
  const transport = createDaemonTransport("fixture-client", socketPath);
  const r = await transport.connect("");
  console.log(r.success ? "connected" : `connect failed: ${r.error.message}`);
  // No explicit exit: if the transport socket holds the event loop, this process never ends.
});
