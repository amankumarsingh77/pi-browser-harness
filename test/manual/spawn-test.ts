import { ensureDaemon, isDaemonRunning } from "../../src/daemon/spawn";

const running = await isDaemonRunning();
console.log("Daemon running:", running);
const result = await ensureDaemon();
console.log("ensureDaemon result:", result);
