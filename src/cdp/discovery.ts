import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { connect as netConnect } from "node:net";
import { request as httpRequest } from "node:http";
import { type Result, err, ok } from "../util/result";
import { userDataDirCandidates } from "../profile/paths";
import { type CdpError, cdpError } from "./errors";
import { asString, errnoCode, isRecord } from "../util/guards";

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
    sock.setTimeout(1000, () => { finish(err(cdpError("discovery_failed", "probe timeout"))); });
    sock.once("error", (e) => { finish(err(cdpError("discovery_failed", e.message))); });
    sock.once("connect", () => { finish(ok(undefined)); });
  });

export type PortProbe = (port: number) => Promise<Result<void, CdpError>>;

export type PortRaceOptions = {
  readonly probe?: PortProbe;
  readonly deadlineMs?: number;
  readonly intervalMs?: number;
};

// Polls every candidate port at once under ONE deadline and settles on the first that answers; a stale DevToolsActivePort can no longer hold discovery for its own full deadline before the next candidate is tried.
export const firstReadyPort = <C extends { readonly port: number }>(
  candidates: ReadonlyArray<C>,
  opts: PortRaceOptions = {},
): Promise<Result<C, CdpError>> => {
  const probe = opts.probe ?? probePort;
  const deadlineMs = opts.deadlineMs ?? PORT_PROBE_DEADLINE_MS;
  const intervalMs = opts.intervalMs ?? PORT_PROBE_INTERVAL_MS;
  if (candidates.length === 0) {
    return Promise.resolve(err(cdpError("discovery_failed", "no DevTools port candidates to probe")));
  }
  const end = Date.now() + deadlineMs;
  const lastMessages = new Map<number, string>();
  const timers = new Set<ReturnType<typeof setTimeout>>();
  let winner: C | undefined;
  let settled = false;

  const pause = (ms: number): Promise<void> =>
    new Promise((resolve) => {
      const t = setTimeout(() => {
        timers.delete(t);
        resolve();
      }, ms);
      timers.add(t);
    });

  // Losers still sleeping are abandoned, not awaited: their timers are cleared so nothing keeps running after a winner.
  const stopAll = (): void => {
    for (const t of timers) clearTimeout(t);
    timers.clear();
  };

  // Read through a call: the awaits in attempt() let another candidate set `winner`, which
  // flow narrowing inside the function cannot see.
  const raceWon = (): boolean => winner !== undefined;

  const attempt = async (c: C): Promise<void> => {
    while (winner === undefined && Date.now() < end) {
      const r = await probe(c.port);
      if (r.success) {
        winner ??= c;
        return;
      }
      lastMessages.set(c.port, r.error.message);
      if (raceWon()) return;
      await pause(Math.min(intervalMs, Math.max(0, end - Date.now())));
    }
  };

  return new Promise((resolve) => {
    let remaining = candidates.length;
    const finish = (r: Result<C, CdpError>): void => {
      if (settled) return;
      settled = true;
      stopAll();
      resolve(r);
    };
    for (const c of candidates) {
      void attempt(c).then(() => {
        if (winner !== undefined) {
          finish(ok(winner));
          return;
        }
        remaining -= 1;
        if (remaining > 0) return;
        const ports = candidates.map((k) => `127.0.0.1:${k.port}`).join(", ");
        const detail = [...lastMessages.entries()].map(([port, m]) => `${port}: ${m}`).join("; ") || "unknown";
        finish(err(cdpError(
          "discovery_failed",
          `Chrome's remote-debugging page is open, but DevTools is not live yet on ${ports} — if Chrome opened a profile picker, choose your normal profile first, then tick the checkbox and click Allow if shown (last error: ${detail})`,
        )));
      });
    }
  });
};

const isPortLive = async (port: number): Promise<boolean> => (await probePort(port)).success;

// /json/version is authoritative: a stale DevToolsActivePort file may name a browser that has since exited while another now owns the port.
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
          resolve(parseVersionResponse(Buffer.concat(chunks).toString("utf8")));
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => { resolve(null); });
    req.end();
  });

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

type Candidate = {
  readonly port: number;
  readonly path: string;
  readonly mtimeMs: number;
  readonly userDataDir: string;
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
    candidates.push({ port: portNum, path, mtimeMs, userDataDir: base });
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

  const byPort = new Map<number, Candidate>();
  for (const c of candidates) {
    const prev = byPort.get(c.port);
    if (!prev || c.mtimeMs > prev.mtimeMs) byPort.set(c.port, c);
  }
  const unique = Array.from(byPort.values());

  const liveChecks = await Promise.all(unique.map((c) => isPortLive(c.port)));
  const liveCandidates = unique.filter((_, i) => liveChecks[i]);
  const ordered = liveCandidates.length > 0 ? liveCandidates : unique;

  // Some browsers disable the /json/version endpoint when remote debugging is toggled via chrome://inspect rather than a launch flag, hence the DevToolsActivePort fallback.
  const ready = await firstReadyPort(ordered);
  if (ready.success) {
    const c = ready.data;
    const liveUrl = await queryLiveWsUrl(c.port);
    return ok({ wsUrl: liveUrl ?? `ws://127.0.0.1:${c.port}${c.path}`, userDataDir: c.userDataDir });
  }

  for (const port of fallbackPorts()) {
    if (byPort.has(port) || !(await isPortLive(port))) continue;
    const liveUrl = await queryLiveWsUrl(port);
    if (liveUrl) return ok({ wsUrl: liveUrl });
  }

  return err(ready.error);
};

export const discoverWsUrl = async (): Promise<Result<string, CdpError>> => {
  const endpoint = await discoverEndpoint();
  return endpoint.success ? ok(endpoint.data.wsUrl) : endpoint;
};
