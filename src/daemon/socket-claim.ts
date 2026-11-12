import { createConnection } from "node:net";
import { linkSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { randomUUID } from "node:crypto";
import { errnoCode } from "../util/guards";
import { sleep } from "../util/sleep";
import { destroyQuietly } from "./socket";

// What is at a socket path, judged by connect() alone. The kernel completes a connect without the
// listener's event loop running, so a busy daemon is still "live"; only a refused connect proves
// the listener is gone. Anything else is "unknown" and must be treated as possibly live.
export type SocketState = "live" | "stale" | "absent" | "unknown";

const SOCKET_PROBE_TIMEOUT_MS = 1_000;

export const probeSocket = (socketPath: string, timeoutMs = SOCKET_PROBE_TIMEOUT_MS): Promise<SocketState> =>
  new Promise((resolve) => {
    let settled = false;
    const sock = createConnection(socketPath);
    const finish = (state: SocketState): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      destroyQuietly(sock);
      resolve(state);
    };
    const timer = setTimeout(() => { finish("unknown"); }, timeoutMs);
    sock.once("connect", () => { finish("live"); });
    sock.once("error", (e) => {
      const code = errnoCode(e);
      finish(code === "ECONNREFUSED" ? "stale" : code === "ENOENT" ? "absent" : "unknown");
    });
  });

export const startupLockPath = (socketPath: string): string => `${socketPath}.lock`;

export type StartupLockOptions = {
  // A lock older than this was abandoned by a daemon that died mid-startup.
  readonly staleMs?: number;
  // How long to wait for another daemon's startup to finish before giving up.
  readonly waitMs?: number;
  readonly pollMs?: number;
};

// A holder keeps the lock for one probe and one bind, which is bounded by the probe timeout.
const LOCK_STALE_MS = 4_000;
const LOCK_WAIT_MS = 8_000;
const LOCK_POLL_MS = 25;

const unlinkQuietly = (path: string): void => {
  try {
    unlinkSync(path);
  } catch {
    // Already gone.
  }
};

const mtimeMs = (path: string): number | null => {
  try {
    return statSync(path).mtimeMs;
  } catch {
    return null;
  }
};

// Moves an abandoned lock aside. The rename is the atomic step: of several daemons that all judged
// the lock stale, each moves a different file or none. A mover that finds it took a fresh lock (a
// rival replaced the stale one in between) puts it back rather than break a live startup.
const breakStaleLock = (lockPath: string, staleMs: number): void => {
  const aside = `${lockPath}.${randomUUID()}`;
  try {
    renameSync(lockPath, aside);
  } catch {
    return;
  }
  const movedAt = mtimeMs(aside);
  if (movedAt !== null && Date.now() - movedAt <= staleMs) {
    try {
      linkSync(aside, lockPath);
    } catch {
      // Another daemon already took the lock; the one displaced here still finishes its own bind safely.
    }
  }
  unlinkQuietly(aside);
};

// Serializes socket claims: binding, and deciding a socket is stale, removing it and binding in its
// place. Held only while a daemon starts, never for its lifetime.
export const withStartupLock = async <T>(
  lockPath: string,
  fn: () => Promise<T>,
  options: StartupLockOptions = {},
): Promise<T> => {
  const staleMs = options.staleMs ?? LOCK_STALE_MS;
  const waitMs = options.waitMs ?? LOCK_WAIT_MS;
  const pollMs = options.pollMs ?? LOCK_POLL_MS;
  const deadline = Date.now() + waitMs;

  for (;;) {
    try {
      writeFileSync(lockPath, String(process.pid), { flag: "wx" });
      break;
    } catch (e) {
      if (errnoCode(e) !== "EEXIST") throw e;
    }
    const heldSince = mtimeMs(lockPath);
    // Falls through to the deadline and the pause either way, so a lock that cannot be moved aside
    // ends in the timeout below rather than a spin.
    if (heldSince !== null && Date.now() - heldSince > staleMs) breakStaleLock(lockPath, staleMs);
    if (Date.now() >= deadline) {
      throw new Error(`another daemon has been starting on ${lockPath} for over ${Math.round(waitMs / 1000)}s`);
    }
    await sleep(pollMs);
  }

  try {
    return await fn();
  } finally {
    unlinkQuietly(lockPath);
  }
};
