// The daemon process entry. spawn.ts launches this file under tsx; it starts the daemon
// unconditionally, so nothing but the spawned process should import it.
import { createDaemon, describeError, LOG_PREFIX } from "./index";

console.log(`${LOG_PREFIX} Starting...`);
const daemon = createDaemon();
process.on("SIGINT", () => { void daemon.stop(); });
process.on("SIGTERM", () => { void daemon.stop(); });
daemon.start().catch((e: unknown) => {
  console.error(`${LOG_PREFIX} Fatal: ${describeError(e)}`);
  process.exit(1);
});
