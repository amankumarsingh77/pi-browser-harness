import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect as netConnect } from "node:net";
import { request as httpRequest } from "node:http";
import { type Result, err, ok } from "../util/result";
import { type CdpError, cdpError } from "./errors";

const PORT_PROBE_DEADLINE_MS = 30_000;
const PORT_PROBE_INTERVAL_MS = 1_000;

const profileDirs = (): ReadonlyArray<string> => {
  const home = homedir();
  return [
    // macOS — Chrome (all channels), Chromium, Brave, Edge
    join(home, "Library/Application Support/Google/Chrome"),
    join(home, "Library/Application Support/Google/Chrome Beta"),
    join(home, "Library/Application Support/Google/Chrome Dev"),
    join(home, "Library/Application Support/Google/Chrome Canary"),
    join(home, "Library/Application Support/Chromium"),
    join(home, "Library/Application Support/BraveSoftware/Brave-Browser"),
    join(home, "Library/Application Support/BraveSoftware/Brave-Browser-Beta"),
    join(home, "Library/Application Support/BraveSoftware/Brave-Browser-Nightly"),
    join(home, "Library/Application Support/BraveSoftware/Brave-Browser-Dev"),
    join(home, "Library/Application Support/Microsoft Edge"),
    join(home, "Library/Application Support/Microsoft Edge Beta"),
    join(home, "Library/Application Support/Microsoft Edge Dev"),
    join(home, "Library/Application Support/Microsoft Edge Canary"),
    // Linux — Chrome (all channels), Chromium, Brave, Edge
    join(home, ".config/google-chrome"),
    join(home, ".config/google-chrome-beta"),
    join(home, ".config/google-chrome-unstable"),
    join(home, ".config/chromium"),
    join(home, ".config/chromium-browser"),
    join(home, ".config/BraveSoftware/Brave-Browser"),
    join(home, ".config/BraveSoftware/Brave-Browser-Beta"),
    join(home, ".config/BraveSoftware/Brave-Browser-Nightly"),
    join(home, ".config/microsoft-edge"),
    join(home, ".config/microsoft-edge-beta"),
    join(home, ".config/microsoft-edge-dev"),
    // Linux flatpak
    join(home, ".var/app/org.chromium.Chromium/config/chromium"),
    join(home, ".var/app/com.google.Chrome/config/google-chrome"),
    join(home, ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser"),
    join(home, ".var/app/com.microsoft.Edge/config/microsoft-edge"),
    // Windows — Chrome, Chromium, Brave, Edge
    join(home, "AppData/Local/Google/Chrome/User Data"),
    join(home, "AppData/Local/Google/Chrome Beta/User Data"),
    join(home, "AppData/Local/Google/Chrome Dev/User Data"),
    join(home, "AppData/Local/Google/Chrome SxS/User Data"),
    join(home, "AppData/Local/Chromium/User Data"),
    join(home, "AppData/Local/BraveSoftware/Brave-Browser/User Data"),
    join(home, "AppData/Local/BraveSoftware/Brave-Browser-Beta/User Data"),
    join(home, "AppData/Local/Microsoft/Edge/User Data"),
    join(home, "AppData/Local/Microsoft/Edge Beta/User Data"),
    join(home, "AppData/Local/Microsoft/Edge Dev/User Data"),
    join(home, "AppData/Local/Microsoft/Edge SxS/User Data"),
  ];
};

const probePort = (port: number): Promise<Result<void, CdpError>> =>
  new Promise((resolve) => {
    const sock = netConnect({ host: "127.0.0.1", port });
    let settled = false;
    const finish = (r: Result<void, CdpError>): void => {
      if (settled) return;
      settled = true;
      sock.setTimeout(0);
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(1000, () => finish(err(cdpError("discovery_failed", "probe timeout"))));
    sock.once("error", (e) => finish(err(cdpError("discovery_failed", e.message))));
    sock.once("connect", () => finish(ok(undefined)));
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

// Fast, single-shot TCP check (no retry loop). Used to skip stale
// DevToolsActivePort files left behind by a browser that has since quit —
// unlike waitForPort, this returns immediately instead of blocking ~30s.
const isPortLive = async (port: number): Promise<boolean> => (await probePort(port)).success;

// Ask the live browser for its canonical webSocketDebuggerUrl via
// http://127.0.0.1:<port>/json/version. This is authoritative: it avoids
// trusting a path from a stale DevToolsActivePort file that may belong to a
// different browser which has since exited (e.g. Chrome's stale file pointing
// at 9222 while Brave actually owns the port now). Returns null if the endpoint
// is unreachable, non-200, or doesn't expose a WS URL.
const queryLiveWsUrl = (port: number, timeoutMs = 1_500): Promise<string | null> =>
  new Promise<string | null>((resolve) => {
    const req = httpRequest(
      { host: "127.0.0.1", port, path: "/json/version", method: "GET", timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          try {
            const json = JSON.parse(Buffer.concat(chunks).toString("utf8")) as Record<string, unknown>;
            const ws = json["webSocketDebuggerUrl"];
            resolve(typeof ws === "string" ? ws : null);
          } catch {
            resolve(null);
          }
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
    req.end();
  });

// Well-known CDP ports to probe when no DevToolsActivePort file is readable
// (sandboxed harness, restricted filesystem permissions, or an unusual profile
// location not on the profileDirs list). The default Chromium remote-debugging
// port is 9222; users can extend via BU_CDP_PORTS="9222,9333".
const fallbackPorts = (): ReadonlyArray<number> => {
  const ports = new Set<number>([9222]);
  const fromEnv = process.env["BU_CDP_PORTS"];
  if (fromEnv) {
    for (const tok of fromEnv.split(",")) {
      const n = Number(tok.trim());
      if (Number.isInteger(n) && n > 0 && n < 65536) ports.add(n);
    }
  }
  return Array.from(ports);
};

type Candidate = { readonly port: number; readonly path: string; readonly mtimeMs: number };

export const discoverWsUrl = async (): Promise<Result<string, CdpError>> => {
  const dirs = profileDirs();

  // Phase 1: collect every readable DevToolsActivePort candidate up front,
  // rather than committing to the first one found. A single browser writes one
  // such file, but stale files from quit browsers linger, so we must
  // disambiguate below instead of trusting discovery order.
  const candidates: Candidate[] = [];
  const readErrors: string[] = [];
  for (const base of dirs) {
    const portFile = join(base, "DevToolsActivePort");
    let raw: string;
    let mtimeMs = 0;
    try {
      raw = await readFile(portFile, "utf8");
      try {
        mtimeMs = (await stat(portFile)).mtimeMs;
      } catch {
        // mtime is only a tiebreaker; a stat failure just leaves it at 0.
      }
    } catch (e) {
      // Node fs errors carry .code; see ErrnoException. ENOENT is normal — the
      // dir is on our list but the user hasn't installed that browser. EPERM/
      // EACCES is common under sandboxes; remember it and fall back to network
      // probing rather than failing the whole discovery.
      const code = (e as NodeJS.ErrnoException).code;
      if (code === "ENOENT" || code === undefined) continue;
      if (code === "EPERM" || code === "EACCES") {
        readErrors.push(`${portFile}: ${code}`);
        continue;
      }
      return err(cdpError("discovery_failed", `failed to read ${portFile}: ${e instanceof Error ? e.message : String(e)}`));
    }
    const lines = raw.trim().split("\n");
    if (lines.length < 2) continue;
    const port = lines[0]?.trim();
    const path = lines[1]?.trim();
    if (!port || !path) continue;
    candidates.push({ port: Number(port), path, mtimeMs });
  }

  // Phase 2: no readable candidate — probe well-known ports directly. Covers
  // sandboxed harnesses that can't read profile dirs and non-default install
  // locations. Requires the browser to have been launched with
  // --remote-debugging-port so /json/version is served.
  if (candidates.length === 0) {
    for (const port of fallbackPorts()) {
      if (!(await isPortLive(port))) continue;
      const live = await queryLiveWsUrl(port);
      if (live) return ok(live);
    }
    const permHint = readErrors.length > 0
      ? `\n\nDevToolsActivePort reads were denied (${readErrors.join(", ")}); if you're running in a sandbox, grant read access to those files or set BU_CDP_WS / BU_CDP_PORTS to bypass file discovery.`
      : "";
    return err(cdpError(
      "discovery_failed",
      `DevToolsActivePort not found in ${dirs.join(", ")} — open chrome://inspect/#remote-debugging (or brave://inspect, edge://inspect) in your browser, tick the checkbox, click Allow, then retry. Or set BU_CDP_WS to a remote browser endpoint.${permHint}`,
    ));
  }

  // Phase 3: disambiguate candidates sharing a port (one browser running, and
  // another's file left behind on the default 9222): keep the most-recently-
  // written file — that's the currently-running browser.
  const byPort = new Map<number, Candidate>();
  for (const c of candidates) {
    const prev = byPort.get(c.port);
    if (!prev || c.mtimeMs > prev.mtimeMs) byPort.set(c.port, c);
  }
  const unique = Array.from(byPort.values());

  // Prefer candidates whose port is actually accepting connections; this skips
  // stale files whose browser has quit (avoiding a ~30s waitForPort block).
  const liveChecks = await Promise.all(unique.map((c) => isPortLive(c.port)));
  const liveCandidates = unique.filter((_, i) => liveChecks[i]);
  const ordered = liveCandidates.length > 0 ? liveCandidates : unique;

  // Phase 4: for each candidate, prefer the browser's own canonical WS URL from
  // /json/version. Some browsers disable that HTTP endpoint when remote
  // debugging is toggled only via chrome://inspect (rather than a launch flag),
  // so fall back to the WS path written in DevToolsActivePort.
  let lastErr: Result<string, CdpError> | null = null;
  for (const c of ordered) {
    const ready = await waitForPort(c.port);
    if (!ready.success) {
      lastErr = err(ready.error);
      continue;
    }
    const liveUrl = await queryLiveWsUrl(c.port);
    return ok(liveUrl ?? `ws://127.0.0.1:${c.port}${c.path}`);
  }
  return lastErr ?? err(cdpError("discovery_failed", "no live DevTools endpoint among discovered candidates"));
};
