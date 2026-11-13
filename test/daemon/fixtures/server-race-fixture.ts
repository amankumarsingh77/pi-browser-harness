// One contender for a daemon socket: starts an IPC server on the given path, reports whether it won,
// and (as a winner) keeps listening until its stdin closes so the parent can count live owners.
import { createIpcServer, isDaemonAlreadyRunning } from "../../../src/daemon/server";

const socketPath = process.argv[2];
if (!socketPath) throw new Error("usage: fixture <socketPath>");

const server = createIpcServer({ socketPath });
server.onMessage((_msg, client) => {
  server.send(client.id, { type: "response", id: 1, result: { pid: process.pid } });
});

const run = async (): Promise<void> => {
  try {
    await server.start();
    console.log("listening");
    process.stdin.on("end", () => {
      void server.stop().then(() => { process.exit(0); });
    });
    process.stdin.resume();
  } catch (e) {
    console.log(isDaemonAlreadyRunning(e) ? "refused" : `error: ${e instanceof Error ? e.message : String(e)}`);
    await server.stop();
    process.exit(0);
  }
};

void run();
