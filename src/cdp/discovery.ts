import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect as netConnect } from "node:net";
import { type Result, err, ok } from "../util/result";
import { type CdpError, cdpError } from "./errors";

const PORT_PROBE_DEADLINE_MS = 30_000;
const PORT_PROBE_INTERVAL_MS = 1_000;

const profileDirs = (): ReadonlyArray<string> => {
  const home = homedir();
  return [
    join(home, "Library/Application Support/Google/Chrome"),
    join(home, "Library/Application Support/Microsoft Edge"),
    join(home, "Library/Application Support/Microsoft Edge Beta"),
    join(home, "Library/Application Support/Microsoft Edge Dev"),
    join(home, "Library/Application Support/Microsoft Edge Canary"),
    join(home, ".config/google-chrome"),
    join(home, ".config/chromium"),
    join(home, ".config/chromium-browser"),
    join(home, ".config/microsoft-edge"),
    join(home, ".config/microsoft-edge-beta"),
    join(home, ".config/microsoft-edge-dev"),
    join(home, ".var/app/org.chromium.Chromium/config/chromium"),
    join(home, ".var/app/com.google.Chrome/config/google-chrome"),
    join(home, ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser"),
    join(home, ".var/app/com.microsoft.Edge/config/microsoft-edge"),
    join(home, "AppData/Local/Google/Chrome/User Data"),
    join(home, "AppData/Local/Chromium/User Data"),
    join(home, "AppData/Local/Microsoft/Edge/User Data"),
    join(home, "AppData/Local/Microsoft/Edge Beta/User Data"),
    join(home, "AppData/Local/Microsoft/Edge Dev/User Data"),
    join(home, "AppData/Local/Microsoft/Edge SxS/User Data"),
  ];
};

const probePort = (port: number): Promise<Result<void, CdpError>> =>
  new Promise((resolve) => {
    const sock = netConnect({ host: "127.0.0.1", port });
    const finish = (r: Result<void, CdpError>): void => {
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(1000, () => finish(err(cdpError("discovery_failed", "probe timeout"))));
    sock.once("error", (e) => finish(err(cdpError("discovery_failed", e.message))));
    sock.once("connect", () => {
      sock.end();
      resolve(ok(undefined));
    });
  });

const waitForPort = async (port: number): Promise<Result<void, CdpError>> => {
  const end = Date.now() + PORT_PROBE_DEADLINE_MS;
  let lastMessage = "unknown";
  while (Date.now() < end) {
    const probe = await probePort(port);
    if (probe.success) return probe;
    lastMessage = probe.error.message;
    await new Promise((r) => setTimeout(r, PORT_PROBE_INTERVAL_MS));
  }
  return err(cdpError(
    "discovery_failed",
    `Chrome's remote-debugging page is open, but DevTools is not live yet on 127.0.0.1:${port} — if Chrome opened a profile picker, choose your normal profile first, then tick the checkbox and click Allow if shown (last error: ${lastMessage})`,
  ));
};

export const discoverWsUrl = async (): Promise<Result<string, CdpError>> => {
  const dirs = profileDirs();
  for (const base of dirs) {
    const portFile = join(base, "DevToolsActivePort");
    let raw: string;
    try {
      raw = await readFile(portFile, "utf8");
    } catch {
      continue;
    }
    const lines = raw.trim().split("\n");
    if (lines.length < 2) continue;
    const port = lines[0]?.trim();
    const path = lines[1]?.trim();
    if (!port || !path) continue;
    const ready = await waitForPort(Number(port));
    if (!ready.success) return ready;
    return ok(`ws://127.0.0.1:${port}${path}`);
  }
  return err(cdpError(
    "discovery_failed",
    `DevToolsActivePort not found in ${dirs.join(", ")} — open chrome://inspect/#remote-debugging in your browser, tick the checkbox, click Allow, then retry. Or set BU_CDP_WS to a remote browser endpoint.`,
  ));
};
