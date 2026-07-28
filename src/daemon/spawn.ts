import { spawn, type ChildProcess } from "node:child_process";
import { access, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { DAEMON_SOCKET_PATH, serialize, type WireControl } from "./protocol";

const moduleDir = dirname(fileURLToPath(import.meta.url));

const isWindows = process.platform === "win32";

// No-op on Windows: a named pipe is not a filesystem entry and unlinking a pipe path throws.
const cleanupStaleSocket = (): void => {
  if (isWindows) return;
  unlink(DAEMON_SOCKET_PATH).catch(() => {});
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
      sock.destroy();
      cleanupStaleSocket();
      done(false);
    }, timeoutMs);

    sock.on("connect", () => {
      const regMsg: WireControl = { type: "control", action: "register", clientId: "_liveness_probe" };
      sock.write(serialize(regMsg) + "\n");
    });

    sock.on("data", (chunk: Buffer) => {
      const text = chunk.toString();
      if (text.includes('"registered"')) {
        clearTimeout(timer);
        const deregMsg: WireControl = { type: "control", action: "deregister", clientId: "_liveness_probe" };
        try { sock.write(serialize(deregMsg) + "\n"); } catch {}
        sock.destroy();
        done(true);
      }
    });

    sock.on("error", () => {
      clearTimeout(timer);
      sock.destroy();
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

export const spawnDaemon = (): ChildProcess | null => {
  const daemonScript = join(moduleDir, "index.ts");

  // Windows npm binaries are `.cmd` shims, which only launch through a shell — spawning one directly yields EINVAL.
  const tsxBinBase = join(moduleDir, "..", "..", "node_modules", ".bin", "tsx");
  const tsxBin = isWindows ? `${tsxBinBase}.cmd` : tsxBinBase;
  const hasLocalTsx = existsSync(tsxBin);

  const cmd = hasLocalTsx ? tsxBin : isWindows ? "npx.cmd" : "npx";
  const args = hasLocalTsx ? [daemonScript] : ["tsx", daemonScript];

  // With shell: true Node passes the command line verbatim, so a path containing spaces must be quoted or it splits into tokens.
  const quote = (s: string): string => (isWindows ? `"${s}"` : s);

  const child = spawn(quote(cmd), args.map(quote), {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
    shell: isWindows,
    windowsVerbatimArguments: isWindows,
  });

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
