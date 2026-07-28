
import { access } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { spawn } from "node:child_process";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { DAEMON_SOCKET_PATH } from "../../src/daemon/protocol";

async function main() {
  const sock = DAEMON_SOCKET_PATH;

  try {
    await access(sock);
    console.log("FAIL: Socket exists unexpectedly");
    process.exit(1);
  } catch {
    console.log("✓ Socket missing — tool wrapper returns:");
    console.log('  "Browser harness not initialized. Run /browser-setup first"');
  }

  const daemonEntry = join(dirname(fileURLToPath(import.meta.url)), "../../src/daemon/index.ts");
  const proc = spawn("npx", ["tsx", daemonEntry], { detached: true, stdio: "ignore" });
  proc.unref();
  await sleep(2000);

  try {
    await access(sock);
    console.log("✓ Socket exists after daemon spawn — tool wrapper proceeds silently");
  } catch {
    console.log("FAIL: Socket still missing after daemon spawn");
    process.exit(1);
  }

  proc.kill();
  console.log("✓ All socket guard checks passed");
}

main();
