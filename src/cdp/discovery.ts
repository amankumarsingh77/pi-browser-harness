import { readFile, stat } from "node:fs/promises";
import { join } from "node:path";
import { connect as netConnect } from "node:net";
import { request as httpRequest } from "node:http";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { parseJson } from "../schemas/parse";
import { type Result, err, ok } from "../util/result";
import { userDataDirCandidates } from "../profile/paths";
import { type CdpError, cdpError } from "./errors";
import { errnoCode } from "../util/guards";

const PORT_PROBE_DEADLINE_MS = 30_000;
const PORT_PROBE_INTERVAL_MS = 1_000;

const VersionResponse = Type.Object(
  { webSocketDebuggerUrl: Type.Optional(Type.String()) },
  { additionalProperties: true },
);

const versionValidator = Compile(VersionResponse);

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
          const parsed = parseJson(Buffer.concat(chunks).toString("utf8"), versionValidator);
          resolve(parsed.success ? parsed.data.webSocketDebuggerUrl ?? null : null);
        });
      },
    );
    req.on("timeout", () => { req.destroy(); resolve(null); });
    req.on("error", () => resolve(null));
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

export const discoverEndpoint = async (): Promise<Result<CdpEndpoint, CdpError>> => {
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
      } catch {}
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
  let lastErr: Result<CdpEndpoint, CdpError> | null = null;
  for (const c of ordered) {
    const ready = await waitForPort(c.port);
    if (!ready.success) {
      lastErr = err(ready.error);
      continue;
    }
    const liveUrl = await queryLiveWsUrl(c.port);
    return ok({ wsUrl: liveUrl ?? `ws://127.0.0.1:${c.port}${c.path}`, userDataDir: c.userDataDir });
  }

  for (const port of fallbackPorts()) {
    if (byPort.has(port) || !(await isPortLive(port))) continue;
    const liveUrl = await queryLiveWsUrl(port);
    if (liveUrl) return ok({ wsUrl: liveUrl });
  }

  return lastErr ?? err(cdpError("discovery_failed", "no live DevTools endpoint among discovered candidates"));
};

export const discoverWsUrl = async (): Promise<Result<string, CdpError>> => {
  const endpoint = await discoverEndpoint();
  return endpoint.success ? ok(endpoint.data.wsUrl) : endpoint;
};
