/**
 * Protocol types and low-level socket communication for the browser-harness daemon.
 *
 * The daemon exposes a Unix socket at /tmp/bu-<NAME>.sock.
 * Protocol: one JSON-line request → one JSON-line response per connection.
 */

import { createConnection } from "node:net";

// ── Request ──────────────────────────────────────────────────────────────────

export interface DaemonRequest {
  /** CDP method (e.g. "Page.navigate") — absent for meta requests */
  method?: string;
  /** CDP parameters */
  params?: Record<string, unknown>;
  /** CDP session ID — null/absent for browser-level (Target.*) calls */
  session_id?: string | null;
  /** Meta command: "drain_events" | "set_session" | "pending_dialog" | "shutdown" */
  meta?: string;
}

// ── Response ─────────────────────────────────────────────────────────────────

export interface DaemonResponse {
  result?: unknown;
  error?: string;
  events?: CDPEvent[];
  session_id?: string;
  dialog?: DialogInfo;
  ok?: boolean;
}

// ── CDP Event ────────────────────────────────────────────────────────────────

export interface CDPEvent {
  method: string;
  params: unknown;
  session_id?: string;
}

// ── Dialog ───────────────────────────────────────────────────────────────────

export interface DialogInfo {
  type: "alert" | "confirm" | "prompt" | "beforeunload";
  message: string;
  defaultPrompt?: string;
}

// ── Tab ──────────────────────────────────────────────────────────────────────

export interface TabInfo {
  targetId: string;
  title: string;
  url: string;
}

// ── Page State ───────────────────────────────────────────────────────────────

export interface PageInfo {
  url: string;
  title: string;
  width: number;
  height: number;
  scrollX: number;
  scrollY: number;
  pageWidth: number;
  pageHeight: number;
}

export type PageInfoResult = PageInfo | { dialog: DialogInfo };

// ── Daemon Status ────────────────────────────────────────────────────────────

export interface DaemonStatus {
  alive: boolean;
  sessionId: string | null;
  pid: number | null;
  namespace: string;
  socketPath: string;
  remoteBrowserId?: string;
}

// ── Remote Config ────────────────────────────────────────────────────────────

export interface RemoteConfig {
  cdpUrl: string;
  browserId: string;
}

// ── Internal URL prefixes to filter ──────────────────────────────────────────

const INTERNAL_PREFIXES = [
  "chrome://",
  "chrome-untrusted://",
  "devtools://",
  "chrome-extension://",
  "about:",
];

export function isInternalUrl(url: string): boolean {
  return INTERNAL_PREFIXES.some((p) => url.startsWith(p));
}

// ── Low-level socket send ────────────────────────────────────────────────────

/**
 * Send a single JSON-line request to the daemon socket and read one JSON-line response.
 * Opens a fresh connection per request (stateless, matches helpers.py _send pattern).
 */
export function sendRequest(
  socketPath: string,
  request: DaemonRequest,
  timeoutMs = 15_000,
): Promise<DaemonResponse> {
  return new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);

    const timer = setTimeout(() => {
      socket.destroy();
      reject(new Error(`Daemon request timed out after ${timeoutMs}ms: ${JSON.stringify(request.method ?? request.meta)}`));
    }, timeoutMs);

    let buffer = "";

    socket.on("connect", () => {
      socket.write(JSON.stringify(request) + "\n");
    });

    socket.on("data", (chunk: Buffer) => {
      buffer += chunk.toString();
      // Response is one JSON line ending with \n
      if (buffer.includes("\n")) {
        clearTimeout(timer);
        const line = buffer.split("\n")[0];
        try {
          const response: DaemonResponse = JSON.parse(line);
          socket.end();
          resolve(response);
        } catch (e) {
          socket.end();
          reject(new Error(`Failed to parse daemon response: ${line.slice(0, 200)}`));
        }
      }
    });

    socket.on("error", (err: NodeJS.ErrnoException) => {
      clearTimeout(timer);
      socket.destroy();
      reject(new Error(`Daemon socket error (${socketPath}): ${err.message}`));
    });

    socket.on("close", () => {
      clearTimeout(timer);
      if (buffer.length === 0) {
        reject(new Error(`Daemon socket closed without response (${socketPath})`));
      }
    });
  });
}

/**
 * Quick check if the daemon socket accepts connections.
 */
export function daemonAlive(socketPath: string, timeoutMs = 1000): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection(socketPath);
    const timer = setTimeout(() => {
      socket.destroy();
      resolve(false);
    }, timeoutMs);

    socket.on("connect", () => {
      clearTimeout(timer);
      socket.end();
      resolve(true);
    });

    socket.on("error", () => {
      clearTimeout(timer);
      resolve(false);
    });
  });
}

/**
 * True health check: send Target.getTargets and verify "result" key in response.
 * A stale daemon can accept socket connections but have a dead CDP websocket.
 */
export async function healthProbe(socketPath: string): Promise<boolean> {
  try {
    const response = await sendRequest(
      socketPath,
      { method: "Target.getTargets", params: {} },
      3000,
    );
    return "result" in response && response.result !== undefined;
  } catch {
    return false;
  }
}
