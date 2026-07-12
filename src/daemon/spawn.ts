/**
 * Daemon lifecycle helpers — spawn detection and lazy launch.
 *
 * The daemon is a standalone long-lived process that owns the single WebSocket
 * to Chrome. pi instances connect to it via a Unix domain socket. This module
 * provides the plumbing to detect a running daemon and spawn one if needed.
 *
 * Reference:
 *   - child_process.spawn detached: https://nodejs.org/docs/latest-v22.x/api/child_process.html#optionsdetached
 */

import { spawn, type ChildProcess } from "node:child_process";
import { access, unlink } from "node:fs/promises";
import { existsSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";
import { createConnection } from "node:net";
import { DAEMON_SOCKET_PATH, serialize, type WireControl } from "./protocol";

const moduleDir = dirname(fileURLToPath(import.meta.url));

const isWindows = process.platform === "win32";

/**
 * Remove a stale POSIX socket file. On Windows the daemon endpoint is a named
 * pipe, which is not a filesystem entry and is torn down automatically when the
 * owning process exits — so there is nothing to unlink, and calling unlink on a
 * pipe path throws. This is a no-op on Windows.
 */
const cleanupStaleSocket = (): void => {
  if (isWindows) return;
  unlink(DAEMON_SOCKET_PATH).catch(() => {});
};

/**
 * Check whether the daemon is running by probing its Unix socket.
 * A file-existence check is unreliable — a crashed daemon leaves a stale socket.
 * We connect, send a register, wait for the registered ack, then disconnect.
 * On failure, clean up the stale socket so ensureDaemon can spawn a fresh one.
 */
export const isDaemonRunning = async (timeoutMs = 2_000): Promise<boolean> => {
  // On POSIX, a missing socket file means the daemon definitely isn't running,
  // so we can short-circuit. Windows named pipes are not filesystem entries —
  // access() always fails there — so skip the pre-check and probe directly.
  if (!isWindows) {
    try {
      await access(DAEMON_SOCKET_PATH);
    } catch {
      return false;
    }
  }

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
      // ponytail: stale socket cleanup; ENOENT = already gone, fine
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
        // Send deregister so the probe doesn't hog a slot
        const deregMsg: WireControl = { type: "control", action: "deregister", clientId: "_liveness_probe" };
        try { sock.write(serialize(deregMsg) + "\n"); } catch {}
        sock.destroy();
        done(true);
      }
    });

    sock.on("error", () => {
      clearTimeout(timer);
      sock.destroy();
      // ponytail: connection refused = daemon dead, clean up stale socket
      cleanupStaleSocket();
      done(false);
    });

    // close without 'registered' ack = daemon alive but rejected us (e.g. max clients);
    // don't unlink — the daemon is still using that socket.
    sock.on("close", () => {
      clearTimeout(timer);
      done(false);
    });
  });
};

/**
 * Spawn the daemon as a detached child process. The daemon will continue
 * running after the parent pi process exits.
 *
 * The daemon entry point is resolved relative to this module. When running
 * from source (tsx), the entry is src/daemon/index.ts. When running compiled,
 * it's dist/daemon/index.js.
 *
 * Returns the child process handle (caller should call child.unref()).
 */
export const spawnDaemon = (): ChildProcess | null => {
  // Resolve the daemon entry point and tsx binary.
  const daemonScript = join(moduleDir, "index.ts");

  // On Windows, npm installs binaries as `.cmd` shims, not bare executables,
  // and the npx fallback is `npx.cmd`. A `.cmd` file can only be launched
  // through a shell (spawning it directly yields EINVAL), so set shell: true
  // whenever we invoke one.
  const tsxBinBase = join(moduleDir, "..", "..", "node_modules", ".bin", "tsx");
  const tsxBin = isWindows ? `${tsxBinBase}.cmd` : tsxBinBase;
  const hasLocalTsx = existsSync(tsxBin);

  // Use the local tsx binary to run the daemon TypeScript source directly.
  // The spawned process inherits the parent's env so module resolution works.
  // Fall back to `npx tsx` if the local binary isn't available.
  const cmd = hasLocalTsx ? tsxBin : isWindows ? "npx.cmd" : "npx";
  const args = hasLocalTsx ? [daemonScript] : ["tsx", daemonScript];

  // With shell: true, Node passes the command line to the shell verbatim
  // without quoting, so any path containing spaces (e.g. C:\Users\Some Name)
  // would be split into multiple tokens. Wrap each token in double quotes on
  // Windows to keep space-containing paths intact.
  const quote = (s: string): string => (isWindows ? `"${s}"` : s);

  const child = spawn(quote(cmd), args.map(quote), {
    detached: true,
    stdio: "ignore",
    env: { ...process.env },
    // `.cmd` shims (local tsx or npx.cmd on Windows) must run via a shell.
    shell: isWindows,
    windowsVerbatimArguments: isWindows,
  });

  child.unref();
  return child;
};

/**
 * Ensure the daemon is running. If not, spawn it and wait (up to timeoutMs)
 * for the socket file to appear.
 *
 * Returns true if the daemon is running (or was successfully spawned).
 */
export const ensureDaemon = async (timeoutMs = 10_000): Promise<boolean> => {
  if (await isDaemonRunning()) return true;

  const child = spawnDaemon();
  if (!child) return false;

  // Poll for the socket file to appear
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await isDaemonRunning()) return true;
    await new Promise((r) => setTimeout(r, 200));
  }

  return false;
};
