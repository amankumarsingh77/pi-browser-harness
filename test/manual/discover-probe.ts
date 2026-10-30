// Manual probe for the WSL-windows-browser path. Not part of the unit suite: it talks to the
// real machine — enumerates /mnt, reads /proc/net/route, and dials the browser's debug port.
// Run it on a machine where pi runs inside WSL and the browser runs on Windows:
//   node --conditions=import --import tsx test/manual/discover-probe.ts
// Expected output: the WSL gate, the resolved endpoint URL, or discovery's error with the
// WSL note — which is itself worth reading: it prints the exact netsh portproxy commands.

import { discoverEndpoint } from "../../src/cdp/discovery";
import { isBrowserRunning } from "../../src/profile/browser-process";
import { isWSL, wslWindowsHostAddress } from "../../src/profile/wsl";

async function main() {
  console.log("WSL detected:", isWSL());
  console.log("Windows host address:", wslWindowsHostAddress() ?? "(none)");
  console.log("isBrowserRunning (WSL file probe, no local process):", JSON.stringify(await isBrowserRunning()));
  const r = await discoverEndpoint();
  console.log(r.success ? `ENDPOINT: ${r.data.wsUrl}` : `ERROR:\n${r.error.message}`);
}

void main();