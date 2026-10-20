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

export const CONTROL_ACTIONS = ["register", "registered", "deregister", "shutdown"] as const;

export type ControlAction = (typeof CONTROL_ACTIONS)[number];

// Each action carries exactly the fields it needs, so a handler that has matched on `action`
// never has to re-check what the guard already proved.
export type WireRegister = { readonly type: "control"; readonly action: "register"; readonly clientId: string };
export type WireRegistered = { readonly type: "control"; readonly action: "registered"; readonly clientId: string };
export type WireDeregister = { readonly type: "control"; readonly action: "deregister"; readonly clientId: string };
export type WireShutdown = { readonly type: "control"; readonly action: "shutdown"; readonly reason?: string };

export type WireControl = WireRegister | WireRegistered | WireDeregister | WireShutdown;

export type WireMessage = WireRequest | WireResponse | WireEvent | WireControl;

const isControlAction = (v: unknown): v is ControlAction =>
  typeof v === "string" && CONTROL_ACTIONS.some((a) => a === v);

const isOptionalString = (v: unknown): v is string | undefined => v === undefined || typeof v === "string";

const isOptionalRecord = (v: unknown): v is Record<string, unknown> | undefined => v === undefined || isRecord(v);

const isWireControl = (v: Record<string, unknown>): v is WireControl => {
  const action = v["action"];
  if (!isControlAction(action)) return false;
  switch (action) {
    case "register":
    case "registered":
    case "deregister":
      return typeof v["clientId"] === "string";
    case "shutdown":
      return isOptionalString(v["reason"]);
  }
};

const isWireMessage = (v: unknown): v is WireMessage => {
  if (!isRecord(v)) return false;
  const t = v["type"];
  if (typeof t !== "string") return false;

  switch (t) {
    case "request": {
      if (typeof v["id"] !== "number") return false;
      if (typeof v["method"] !== "string") return false;
      if (!isOptionalRecord(v["params"])) return false;
      return isOptionalString(v["sessionId"]);
    }
    case "response": {
      if (typeof v["id"] !== "number") return false;
      const errVal = v["error"];
      if (errVal !== undefined) {
        if (!isRecord(errVal)) return false;
        if (typeof errVal["message"] !== "string") return false;
        if (typeof errVal["code"] !== "number") return false;
        if (!isOptionalString(errVal["data"])) return false;
      }
      return true;
    }
    case "event": {
      if (typeof v["method"] !== "string") return false;
      if (!isOptionalRecord(v["params"])) return false;
      return isOptionalString(v["sessionId"]);
    }
    case "control":
      return isWireControl(v);
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

// How long a caller waits for a Chrome connection before being told "not connected". The dial
// itself keeps going (see CDP_ATTEMPT_LIFETIME_MS): a human answering Chrome's "Allow remote
// debugging" prompt takes longer than any tool call should block.
export const CDP_CONNECT_TIMEOUT_MS = 10_000;

// How long one dial stays open waiting for Chrome. One dial is one "Allow" prompt, so the attempt
// must outlive a user who is away from the keyboard rather than be replaced by a fresh prompt.
export const CDP_ATTEMPT_LIFETIME_MS = 5 * 60 * 1000;

// After a dial fails outright (discovery failed, refused, denied, lifetime passed), no automatic
// re-dial happens until this cooldown passes; it doubles per consecutive failure up to the cap.
// An explicit Daemon.reconnect request (/browser-setup, /browser-reload-daemon) bypasses it.
export const CDP_RECONNECT_COOLDOWN_MS = 30_000;
export const CDP_RECONNECT_COOLDOWN_MAX_MS = 5 * 60 * 1000;

// The one request the daemon answers itself: clears the reconnect cooldown and dials Chrome now.
export const DAEMON_RECONNECT_METHOD = "Daemon.reconnect";

export const CDP_COMMAND_TIMEOUT_MS = 10_000;
