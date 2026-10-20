// Connects a daemon transport to a fake daemon that lives in this same process, with every handle
// the fake owns unref'd. The only thing that can keep this process alive afterwards is the
// transport's own socket, so "does the process exit on its own" is the behavior under test.
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { createDaemonTransport } from "../../../src/daemon/transport";
import { deserialize, serialize } from "../../../src/daemon/protocol";

const socketPath = process.argv[2];
if (!socketPath) throw new Error("usage: fixture <socketPath>");

const server = createServer((conn) => {
  conn.unref();
  const rl = createInterface({ input: conn, crlfDelay: Infinity });
  rl.on("line", (line) => {
    const msg = deserialize(line);
    if (msg?.type === "control" && msg.action === "register") {
      conn.write(serialize({ type: "control", action: "registered", clientId: msg.clientId }) + "\n");
    }
  });
});
server.unref();
const connect = async (): Promise<void> => {
  const transport = createDaemonTransport("fixture-client", socketPath);
  const r = await transport.connect("");
  console.log(r.success ? "connected" : `connect failed: ${r.error.message}`);
  // No explicit exit: if the transport socket holds the event loop, this process never ends.
};
server.listen(socketPath, () => {
  connect().catch((e: unknown) => {
    console.error(e);
    process.exitCode = 1;
  });
});
