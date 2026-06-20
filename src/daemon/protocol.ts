/**
 * Unix socket daemon protocol — wire message types, type guards, and constants.
 *
 * The daemon speaks JSON-line protocol over a Unix domain socket.
 * One JSON object per newline. Four message types: request, response, event, control.
 *
 * References:
 *   - CDP message format: https://github.com/aslushnikov/getting-started-with-cdp#protocol-fundamentals
 *   - net.createServer IPC: https://nodejs.org/docs/latest-v22.x/api/net.html#serverlistenpath-backlog-callback
 *   - readline line-delimited: https://nodejs.org/docs/latest-v22.x/api/readline.html#event-line
 */

// ── Message types ──────────────────────────────────────────────────────────────

/** A CDP command sent from a pi client to the daemon. */
export type WireRequest = {
  readonly type: "request";
  /** Client-local CDP id. The daemon remaps this to a globally-unique id for Chrome. */
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  /** Optional CDP session id. Omitted for browser-level commands. */
  readonly sessionId?: string;
};

/** A CDP response (result or error) sent from the daemon back to the pi client. */
export type WireResponse = {
  readonly type: "response";
  /** Matches the id from the corresponding WireRequest. */
  readonly id: number;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: string;
  };
};

/** A CDP event forwarded from Chrome through the daemon to pi client(s). */
export type WireEvent = {
  readonly type: "event";
  readonly method: string;
  readonly params?: Record<string, unknown>;
  /** Session-scoped events carry this; browser-level events omit it. */
  readonly sessionId?: string;
};

/** Daemon lifecycle control messages. Bidirectional. */
export type WireControl = {
  readonly type: "control";
  readonly action: "register" | "registered" | "deregister" | "shutdown";
  /** pi client namespace (required for register/registered/deregister). */
  readonly clientId?: string;
  /** Human-readable reason for shutdown. */
  readonly reason?: string;
};

/** All messages that may appear on the Unix socket. */
export type WireMessage = WireRequest | WireResponse | WireEvent | WireControl;

// ── Type guard ─────────────────────────────────────────────────────────────────

const isObject = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

/**
 * Validates that an unknown parsed-JSON value is a well-formed WireMessage.
 * Does NOT validate the full CDP semantics — only structural shape.
 */
export const isWireMessage = (v: unknown): v is WireMessage => {
  if (!isObject(v)) return false;
  const t = v["type"];
  if (typeof t !== "string") return false;

  switch (t) {
    case "request": {
      if (typeof v["id"] !== "number") return false;
      if (typeof v["method"] !== "string") return false;
      const sid = v["sessionId"];
      if (sid !== undefined && typeof sid !== "string") return false;
      return true;
    }
    case "response": {
      if (typeof v["id"] !== "number") return false;
      const errVal = v["error"];
      if (errVal !== undefined) {
        if (!isObject(errVal)) return false;
        if (typeof errVal["message"] !== "string") return false;
        if (typeof errVal["code"] !== "number") return false;
      }
      return true;
    }
    case "event": {
      if (typeof v["method"] !== "string") return false;
      const sid = v["sessionId"];
      if (sid !== undefined && typeof sid !== "string") return false;
      return true;
    }
    case "control": {
      const action = v["action"];
      if (typeof action !== "string") return false;
      if (!["register", "registered", "deregister", "shutdown"].includes(action)) return false;
      const cid = v["clientId"];
      if (
        (action === "register" || action === "registered" || action === "deregister") &&
        typeof cid !== "string"
      ) {
        return false;
      }
      return true;
    }
    default:
      return false;
  }
};

// ── Wire message constructors ──────────────────────────────────────────────────

/** Serialize a WireMessage to a JSON line (no trailing newline — caller adds \\n). */
export const serialize = (msg: WireMessage): string => JSON.stringify(msg);

/** Deserialize a single JSON-line string to a WireMessage. Returns null on parse failure. */
export const deserialize = (line: string): WireMessage | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isWireMessage(parsed)) return null;
  return parsed;
};

// ── Constants ──────────────────────────────────────────────────────────────────

/** Filesystem path for the daemon's Unix domain socket. */
export const DAEMON_SOCKET_PATH = "/tmp/pi-browser-daemon.sock";

/**
 * How long the daemon stays alive with zero connected clients before exiting
 * (milliseconds). After this period, the daemon cleans up and shuts down.
 */
export const DAEMON_IDLE_TIMEOUT_MS = 30 * 60 * 1000; // 30 minutes

/**
 * Hard cap on concurrent pi client connections. Extra connections are rejected
 * immediately to prevent resource exhaustion.
 */
export const DAEMON_MAX_CLIENTS = 16;

/**
 * If true, the daemon unlinks (deletes) any stale socket file from a previous
 * daemon crash before calling server.listen(). Without this, a crashed daemon
 * leaves a socket inode that blocks the next listen() call with EADDRINUSE.
 */
export const DAEMON_STALE_SOCKET_CLEANUP = true;

/** CDP WebSocket connection timeout (ms). */
export const CDP_CONNECT_TIMEOUT_MS = 10_000;

/** CDP command timeout when proxying through daemon (ms). */
export const CDP_COMMAND_TIMEOUT_MS = 10_000;
