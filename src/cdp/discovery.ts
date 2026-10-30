import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { connect as netConnect } from "node:net";
import { request as httpRequest } from "node:http";
import { type Result, err, ok } from "../util/result";
import { userDataDirCandidates } from "../profile/paths";
import { isWSL, wslWindowsHostAddress } from "../profile/wsl";
import { type CdpError, cdpError } from "./errors";
import { asString, errnoCode, isRecord } from "../util/guards";
import { sleep } from "../util/sleep";

const PORT_PROBE_DEADLINE_MS = 30_000;
const PORT_PROBE_INTERVAL_MS = 1_000;

// Hand-rolled on purpose: this file runs inside the daemon, a separate Node process that pi does not
// supply host-provided packages (typebox) to. Everything the daemon imports must be a runtime
// dependency or a builtin; test/daemon/entry-imports-test.ts enforces that.
export const parseVersionResponse = (raw: string): string | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed)) return null;
  return asString(parsed["webSocketDebuggerUrl"]) ?? null;
};

export type CdpEndpoint = {
  readonly wsUrl: string;
  readonly userDataDir?: string;
};

const probePort = (port: number, host = "127.0.0.1"): Promise<Result<void, CdpError>> =>
  new Promise((resolve) => {
    const sock = netConnect({ host, port });
    let settled = false;
    const finish = (r: Result<void, CdpError>): void => {
      if (settled) return;
      settled = true;
      sock.setTimeout(0);
      sock.destroy();
      resolve(r);
    };
    sock.setTimeout(1000, () => { finish(err(cdpError("discovery_failed", "probe timeout"))); });
    sock.once("error", (e) => { finish(err(cdpError("discovery_failed", e.message))); });
    sock.once("connect", () => { finish(ok(undefined)); });
  });

export type PortProbe = (port: number, host?: string) => Promise<Result<void, CdpError>>;

export type PortRaceOptions = {
  readonly probe?: PortProbe;
  readonly deadlineMs?: number;
  readonly intervalMs?: number;
};

// Polls every candidate port at once under ONE deadline and settles on the first that answers; a stale DevToolsActivePort can no longer hold discovery for its own full deadline before the next candidate is tried.
// Candidates may carry a host (Windows profile read through /mnt under WSL) — that host is passed through to the probe, and `${host}:${port}` identifies a candidate everywhere race state is kept.
export const firstReadyPort = async <C extends { readonly port: number; readonly host?: string }>(
  candidates: ReadonlyArray<C>,
  opts: PortRaceOptions = {},
): Promise<Result<C, CdpError>> => {
  const probe = opts.probe ?? probePort;
  const deadlineMs = opts.deadlineMs ?? PORT_PROBE_DEADLINE_MS;
  const intervalMs = opts.intervalMs ?? PORT_PROBE_INTERVAL_MS;
  if (candidates.length === 0) return err(cdpError("discovery_failed", "no DevTools port candidates to probe"));

  // One controller ends every loser the moment a winner appears (or the deadline passes).
  const stop = new AbortController();
  const deadline = setTimeout(() => { stop.abort(); }, deadlineMs);
  const lastMessages = new Map<string, string>();

  const label = (c: C): string => `${c.host ?? "127.0.0.1"}:${c.port}`;

  const poll = async (c: C): Promise<C> => {
    while (!stop.signal.aborted) {
      const r = await probe(c.port, c.host);
      if (r.success) return c;
      lastMessages.set(label(c), r.error.message);
      await sleep(intervalMs, stop.signal);
    }
    throw new Error(lastMessages.get(label(c)) ?? "aborted");
  };

  try {
    return ok(await Promise.any(candidates.map(poll)));
  } catch {
    const ports = candidates.map(label).join(", ");
    const detail = [...lastMessages.entries()].map(([addr, m]) => `${addr}: ${m}`).join("; ") || "unknown";
    return err(cdpError(
      "discovery_failed",
      `Chrome's remote-debugging page is open, but DevTools is not live yet on ${ports} — if Chrome opened a profile picker, choose your normal profile first, then tick the checkbox and click Allow if shown (last error: ${detail})`,
    ));
  } finally {
    clearTimeout(deadline);
    stop.abort();
  }
};

const isPortLive = async (port: number, host?: string): Promise<boolean> => (await probePort(port, host)).success;

// /json/version is authoritative: a stale DevToolsActivePort file may name a browser that has since exited while another now owns the port.
const queryLiveWsUrl = (port: number, host = "127.0.0.1", timeoutMs = 1_500): Promise<string | null> =>
  new Promise<string | null>((resolve) => {
    const req = httpRequest(
      { host, port, path: "/json/version", method: "GET", timeout: timeoutMs },
      (res) => {
        if (res.statusCode !== 200) {
          res.resume();
          resolve(null);
          return;
        }
        const chunks: Buffer[] = [];
        res.on("data", (c: Buffer) => chunks.push(c));
        res.on("end", () => {
          resolve(parseVersionResponse(Buffer.concat(chunks).toString("utf8")));
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => { resolve(null); });
    req.end();
  });

// Chrome reports webSocketDebuggerUrl with its loopback address; over a bridge host the client
// must dial that host instead.
export const rewriteWsHost = (wsUrl: string, host: string): string => {
  if (host === "127.0.0.1" || host === "localhost") return wsUrl;
  try {
    const url = new URL(wsUrl);
    if (url.hostname !== "127.0.0.1" && url.hostname !== "localhost") return wsUrl;
    url.hostname = host;
    const rewritten = url.toString();
    return rewritten === wsUrl ? wsUrl : rewritten;
  } catch {
    return wsUrl;
  }
};

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

// Hosts to try for a bare port, in order: the shared loopback (also covers WSL mirrored
// networking), then — under WSL NAT — the Windows host address on the WSL subnet, which a
// one-time portproxy on the Windows side can forward to the browser's loopback port.
const fallbackProbeHosts = (): ReadonlyArray<string> => {
  if (process.platform !== "linux" || !isWSL()) return ["127.0.0.1"];
  const gateway = wslWindowsHostAddress();
  return gateway ? ["127.0.0.1", gateway] : ["127.0.0.1"];
};

// Windows browser profiles read through /mnt under WSL advertise a port bound on the Windows
// side: probe the loopback first (mirrored networking), then the gateway (portproxy, or a
// browser bound beyond loopback).
const isWindowsMountProfile = (userDataDir: string): boolean =>
  userDataDir.startsWith("/mnt/") && userDataDir.includes("AppData/Local");

const candidateHosts = (userDataDir: string): ReadonlyArray<string> => {
  if (!isWSL() || !isWindowsMountProfile(userDataDir)) return ["127.0.0.1"];
  const gateway = wslWindowsHostAddress();
  return gateway ? ["127.0.0.1", gateway] : ["127.0.0.1"];
};

const WSL_PORTPROXY_HINT = (gateway: string, port: number): string =>
  `\n\nWSL note: the browser runs on Windows and binds port ${port} to the Windows loopback, ` +
  `which WSL cannot reach in NAT mode. Either switch WSL to mirrored networking ` +
  `(add "networkingMode=mirrored" under [wsl2] in %USERPROFILE%\\.wslconfig, then run wsl --shutdown) ` +
  `or forward the port once from an admin PowerShell on Windows (then retry here):\n` +
  `  netsh interface portproxy add v4tov4 listenaddress=${gateway} listenport=${port} connectaddress=127.0.0.1 connectport=${port}\n` +
  `  netsh advfirewall firewall add rule name="pi-browser-harness-wsl" dir=in action=allow protocol=TCP localport=${port} remoteip=LocalSubnet\n` +
  `Alternatively set BU_CDP_WS to a browser WebSocket URL that is reachable from WSL.`;

type Candidate = {
  readonly port: number;
  readonly path: string;
  readonly mtimeMs: number;
  readonly userDataDir: string;
  // Host to dial; defaults to the shared loopback. Windows profiles under /mnt (WSL) also carry the Windows host address.
  readonly host: string;
};

// Read here rather than in the client: the daemon owns the only socket to Chrome, so an override the daemon cannot see has no effect.
export const endpointFromEnv = (env: NodeJS.ProcessEnv = process.env): CdpEndpoint | undefined => {
  const wsUrl = env["BU_CDP_WS"]?.trim();
  return wsUrl ? { wsUrl } : undefined;
};

export const discoverEndpoint = async (): Promise<Result<CdpEndpoint, CdpError>> => {
  const override = endpointFromEnv();
  if (override) return ok(override);

  const dirs = userDataDirCandidates();

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
        // The file was readable a moment ago; without an mtime it is simply treated as fresh.
      }
    } catch (e) {
      // EPERM/EACCES is common under sandboxes; remember it and fall back to network probing rather than failing the whole discovery.
      const code = errnoCode(e);
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
    // An out-of-range port makes net.connect throw ERR_SOCKET_BAD_PORT synchronously, escaping discoverWsUrl instead of surfacing as a Result error.
    const portNum = Number(port);
    if (!Number.isInteger(portNum) || portNum <= 0 || portNum >= 65536) continue;
    candidates.push({ port: portNum, path, mtimeMs, userDataDir: base, host: "127.0.0.1" });
    for (const host of candidateHosts(base)) {
      if (host !== "127.0.0.1") candidates.push({ port: portNum, path, mtimeMs, userDataDir: base, host });
    }
  }

  if (candidates.length === 0) {
    for (const port of fallbackPorts()) {
      if (!(await isPortLive(port))) continue;
      const live = await queryLiveWsUrl(port);
      if (live) return ok({ wsUrl: live });
    }
    const permHint = readErrors.length > 0
      ? `\n\nDevToolsActivePort reads were denied (${readErrors.join(", ")}); if you're running in a sandbox, grant read access to those files or set BU_CDP_WS / BU_CDP_PORTS to bypass file discovery.`
      : "";
    return err(cdpError(
      "discovery_failed",
      `DevToolsActivePort not found in ${dirs.join(", ")} — open chrome://inspect/#remote-debugging (or brave://inspect, edge://inspect) in your browser, tick the checkbox, click Allow, then retry. Or set BU_CDP_WS to a remote browser endpoint.${permHint}`,
    ));
  }

  const byHostPort = new Map<string, Candidate>();
  for (const c of candidates) {
    const key = `${c.host}:${c.port}`;
    const prev = byHostPort.get(key);
    if (!prev || c.mtimeMs > prev.mtimeMs) byHostPort.set(key, c);
  }
  const unique = Array.from(byHostPort.values());

  const liveChecks = await Promise.all(unique.map((c) => isPortLive(c.port, c.host)));
  const liveCandidates = unique.filter((_, i) => liveChecks[i]);
  const ordered = liveCandidates.length > 0 ? liveCandidates : unique;

  // Some browsers disable the /json/version endpoint when remote debugging is toggled via chrome://inspect rather than a launch flag, hence the DevToolsActivePort fallback.
  const ready = await firstReadyPort(ordered);
  if (ready.success) {
    const c = ready.data;
    const liveUrl = await queryLiveWsUrl(c.port, c.host);
    return ok({
      wsUrl: liveUrl ? rewriteWsHost(liveUrl, c.host) : `ws://${c.host}:${c.port}${c.path}`,
      userDataDir: c.userDataDir,
    });
  }

  for (const port of fallbackPorts()) {
    for (const host of fallbackProbeHosts()) {
      if (byHostPort.has(`${host}:${port}`)) continue;
      if (!(await isPortLive(port, host))) continue;
      const liveUrl = await queryLiveWsUrl(port, host);
      if (liveUrl) return ok({ wsUrl: rewriteWsHost(liveUrl, host) });
    }
  }

  const error = ready.error;
  const crossHost = unique.find((c) => c.host !== "127.0.0.1");
  if (crossHost) {
    const gateway = wslWindowsHostAddress();
    if (gateway) return err(cdpError(error.kind, `${error.message}${WSL_PORTPROXY_HINT(gateway, crossHost.port)}`));
  }
  return err(error);
};

export const discoverWsUrl = async (): Promise<Result<string, CdpError>> => {
  const endpoint = await discoverEndpoint();
  return endpoint.success ? ok(endpoint.data.wsUrl) : endpoint;
};
