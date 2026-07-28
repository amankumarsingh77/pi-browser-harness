
import { isRecord } from "../util/guards";


export type WireRequest = {
  readonly type: "request";
  readonly id: number;
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
};

export type WireResponse = {
  readonly type: "response";
  readonly id: number;
  readonly result?: unknown;
  readonly error?: {
    readonly code: number;
    readonly message: string;
    readonly data?: string;
  };
};

export type WireEvent = {
  readonly type: "event";
  readonly method: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
};

export type WireControl = {
  readonly type: "control";
  readonly action: "register" | "registered" | "deregister" | "shutdown";
  readonly clientId?: string;
  readonly reason?: string;
};

export type WireMessage = WireRequest | WireResponse | WireEvent | WireControl;


export const isWireMessage = (v: unknown): v is WireMessage => {
  if (!isRecord(v)) return false;
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
        if (!isRecord(errVal)) return false;
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


export const serialize = (msg: WireMessage): string => JSON.stringify(msg);

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


// Windows requires a named pipe (`\\.\pipe\<name>`); a Unix path is not a valid `net` listen/connect target there.
export const DAEMON_SOCKET_PATH =
  process.platform === "win32"
    ? "\\\\.\\pipe\\pi-browser-daemon"
    : "/tmp/pi-browser-daemon.sock";

export const DAEMON_IDLE_TIMEOUT_MS = 30 * 60 * 1000;

export const DAEMON_MAX_CLIENTS = 16;

export const DAEMON_STALE_SOCKET_CLEANUP = true;

export const CDP_CONNECT_TIMEOUT_MS = 10_000;

export const CDP_COMMAND_TIMEOUT_MS = 10_000;
