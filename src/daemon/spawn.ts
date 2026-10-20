import { spawn, type ChildProcess } from "node:child_process";
import { accessSync } from "node:fs";
import { access, unlink } from "node:fs/promises";
import { createRequire } from "node:module";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { readLines } from "./lines";
import { DAEMON_SOCKET_PATH, deserialize, serialize, type WireControl } from "./protocol";
import { destroyQuietly } from "./socket";

const moduleDir = dirname(fileURLToPath(import.meta.url));

const requireFromHere = createRequire(import.meta.url);

const isWindows = process.platform === "win32";

// No-op on Windows: a named pipe is not a filesystem entry and unlinking a pipe path throws.
const cleanupStaleSocket = (): void => {
  if (isWindows) return;
  // ENOENT is the normal case; anything else surfaces when listen() fails.
  unlink(DAEMON_SOCKET_PATH).catch(() => undefined);
};

export const daemonSocketMayExist = async (
  platform: NodeJS.Platform = process.platform,
  socketPath: string = DAEMON_SOCKET_PATH,
): Promise<boolean> => {
  if (platform === "win32") return true;
  try {
    await access(socketPath);
    return true;
  } catch {
    return false;
  }
};

export const isDaemonRunning = async (timeoutMs = 2_000): Promise<boolean> => {
  if (!(await daemonSocketMayExist())) return false;

  return new Promise((resolve) => {
    let settled = false;
    const done = (alive: boolean): void => {
      if (settled) return;
      settled = true;
      resolve(alive);
    };

    const sock = createConnection(DAEMON_SOCKET_PATH);
    const timer = setTimeout(() => {
      destroyQuietly(sock);
      cleanupStaleSocket();
      done(false);
    }, timeoutMs);

    sock.on("connect", () => {
      const regMsg: WireControl = { type: "control", action: "register", clientId: "_liveness_probe" };
      sock.write(serialize(regMsg) + "\n");
    });

    // Line-framed like every other reader of this protocol: a chunk may hold a partial line.
    readLines(sock, (line) => {
      const msg = deserialize(line);
      if (msg?.type !== "control" || msg.action !== "registered") return;
      clearTimeout(timer);
      const deregMsg: WireControl = { type: "control", action: "deregister", clientId: "_liveness_probe" };
      // end() lets the deregister reach the daemon; destroy() would drop it unflushed.
      try { sock.end(serialize(deregMsg) + "\n"); } catch { destroyQuietly(sock); }
      done(true);
    });

    sock.on("error", () => {
      clearTimeout(timer);
      destroyQuietly(sock);
      cleanupStaleSocket();
      done(false);
    });

    // Closed without a 'registered' ack: the daemon is alive but rejected us, so do NOT unlink its socket.
    sock.on("close", () => {
      clearTimeout(timer);
      done(false);
    });
  });
};

// Walks upward like Node's own node_modules lookup. Exported with an injectable start so the
// hoisted layout pi uses can be exercised against a fixture instead of this checkout.
export const resolveTsxCliFromFilesystem = (startDir: string = moduleDir): string | null => {
  for (let dir = startDir; ; dir = dirname(dir)) {
    const candidate = join(dir, "node_modules", "tsx", "dist", "cli.mjs");
    try {
      accessSync(candidate);
      return candidate;
    } catch {
      // Keep walking toward the filesystem root. This mirrors Node's node_modules lookup
      // without relying on createRequire().resolve(), which is broken for external modules
      // loaded through jiti/static inside a Bun-compiled executable such as pi.exe.
    }
    // dirname() of the filesystem root is the root itself.
    if (dirname(dir) === dir) return null;
  }
};

const resolveTsxCli = (): string | null => {
  try {
    const resolved = requireFromHere.resolve("tsx/cli");
    // A compiled runtime may theoretically return a virtual path that a separately spawned
    // Node process cannot read. Only accept a resolver result that exists on the host FS.
    accessSync(resolved);
    return resolved;
  } catch {
    return resolveTsxCliFromFilesystem();
  }
};

export const daemonNodeExecutable = (
  env: NodeJS.ProcessEnv = process.env,
  versions: Readonly<Record<string, string | undefined>> = process.versions,
  platform: NodeJS.Platform = process.platform,
  execPath: string = process.execPath,
): string => {
  const override = env["PI_BROWSER_NODE"];
  if (override) return override;

  // Under normal Node keep the exact executable that launched pi/the extension. Under Bun,
  // process.execPath is bun/pi.exe, not Node, so run the tsx CLI with the required Node runtime.
  if ("bun" in versions) return platform === "win32" ? "node.exe" : "node";

  return execPath;
};

export const daemonSpawnCommand = (): { readonly command: string; readonly args: ReadonlyArray<string> } | null => {
  const daemonScript = join(moduleDir, "main.ts");
  const tsxCli = resolveTsxCli();
  if (!tsxCli) return null;

  return {
    command: daemonNodeExecutable(),
    args: [tsxCli, daemonScript],
  };
};

export const spawnDaemon = (): ChildProcess | null => {
  const spec = daemonSpawnCommand();
  if (!spec) return null;

  const child = spawn(spec.command, [...spec.args], {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
    windowsHide: true,
  });

  // `spawn` reports a missing executable (a bare `node` that is not on PATH under a Bun host)
  // asynchronously via `error`; without a listener that is an uncaught exception in pi.
  // ensureDaemon's poll loop reports the failure as a timeout, which is what the user sees.
  child.on("error", () => undefined);

  child.unref();
  return child;
};

export const ensureDaemon = async (timeoutMs = 10_000): Promise<boolean> => {
  if (await isDaemonRunning()) return true;

  const child = spawnDaemon();
  if (!child) return false;

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDaemonRunning()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }

  return false;
};
