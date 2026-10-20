import WebSocket from "ws";
import { discoverWsUrl } from "../cdp/discovery";
import { CDP_CONNECT_TIMEOUT_MS } from "./protocol";
import type { CdpError } from "../cdp/errors";
import { type Result, err, ok } from "../util/result";

// Why an attempt ended. Only "dropped" means clients were relying on a live Chrome connection
// that went away unannounced; "failed" never got that far, "stopped" is the daemon's own doing,
// and "superseded" is a closing socket that a newer attempt had already replaced.
export type ConnectionEndReason = "failed" | "dropped" | "stopped" | "superseded";

export type ConnectionEvents = {
  readonly onMessage: (raw: string) => void;
  // Fires exactly once per attempt. `generation` identifies the attempt so the caller can
  // fail only the requests it sent on that socket.
  readonly onEnd: (generation: number, reason: ConnectionEndReason) => void;
};

export type ChromeConnectionDependencies = {
  readonly discoverWsUrl?: () => Promise<Result<string, CdpError>>;
  readonly createWebSocket?: (url: string) => ChromeSocket;
  readonly connectTimeoutMs?: number;
  readonly onAttemptSettled?: () => void;
};

export type ChromeConnection = {
  // Clears a previous stop() and dials Chrome. Resolves true once the socket is open.
  readonly start: () => Promise<boolean>;
  // Dials Chrome unless already open or stopped. Concurrent callers share the attempt in
  // flight; the promise resolves when that attempt settles (open, failed, or timed out).
  readonly connect: () => Promise<boolean>;
  readonly isOpen: () => boolean;
  // The generation of the current attempt or open socket; tag requests with it.
  readonly generation: () => number;
  readonly send: (payload: string) => Result<void, string>;
  readonly stop: () => void;
};

type Attempt = {
  readonly generation: number;
  readonly settledPromise: Promise<boolean>;
  socket: ChromeSocket | null;
  opened: boolean;
  ended: boolean;
  superseded: boolean;
  readonly settle: (opened: boolean) => void;
  readonly end: (reason: ConnectionEndReason) => void;
};

// The slice of ws's WebSocket the connection drives. Expressed structurally so a test can hand in
// an EventEmitter-based fake without claiming to be the whole ws class.
export type ChromeSocket = {
  readonly readyState: number;
  on(event: "open" | "close", listener: () => void): unknown;
  on(event: "message", listener: (data: WebSocket.Data) => void): unknown;
  on(event: "error", listener: (error: Error) => void): unknown;
  send(data: string): void;
  close(): void;
};

// ws delivers frames as a string, a Buffer, an ArrayBuffer or a list of Buffers.
const wsDataToString = (data: WebSocket.Data): string => {
  if (typeof data === "string") return data;
  if (Array.isArray(data)) return Buffer.concat(data).toString("utf8");
  if (data instanceof ArrayBuffer) return Buffer.from(data).toString("utf8");
  return data.toString("utf8");
};

const closeSocket = (socket: ChromeSocket): void => {
  if (socket.readyState === WebSocket.CLOSED) return;
  try {
    socket.close();
  } catch {
    // Closing an already-closing socket throws; the socket is gone either way.
  }
};

// On-demand Chrome connection. Attempts happen only from start() and from connect() while
// disconnected; a failed or dropped connection stays disconnected until the next explicit
// browser demand. No background retry loop.
export const createChromeConnection = (
  deps: ChromeConnectionDependencies,
  events: ConnectionEvents,
): ChromeConnection => {
  const {
    discoverWsUrl: discover = discoverWsUrl,
    createWebSocket = (url: string): ChromeSocket => new WebSocket(url, { perMessageDeflate: false }),
    connectTimeoutMs = CDP_CONNECT_TIMEOUT_MS,
    onAttemptSettled,
  } = deps;

  let current: Attempt | null = null;
  let stopped = false;
  let lastGeneration = 0;

  const startAttempt = (): Attempt => {
    const generation = ++lastGeneration;
    let resolveSettled: (opened: boolean) => void = () => undefined;
    const settledPromise = new Promise<boolean>((resolve) => { resolveSettled = resolve; });
    let settled = false;
    // The whole attempt, discovery included, is bounded by one timer.
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => { attempt.end("failed"); }, connectTimeoutMs);

    const attempt: Attempt = {
      generation,
      settledPromise,
      socket: null,
      opened: false,
      ended: false,
      superseded: false,
      settle: (opened) => {
        if (settled) return;
        settled = true;
        if (timer) { clearTimeout(timer); timer = null; }
        resolveSettled(opened);
        onAttemptSettled?.();
      },
      end: (reason) => {
        if (attempt.ended) return;
        attempt.ended = true;
        if (current === attempt) current = null;
        if (attempt.socket) closeSocket(attempt.socket);
        attempt.settle(false);
        events.onEnd(generation, reason);
      },
    };
    return attempt;
  };

  const run = async (attempt: Attempt): Promise<void> => {
    const d = await discover();
    if (attempt.ended) return;
    if (!d.success) { attempt.end("failed"); return; }

    let socket: ChromeSocket;
    try {
      socket = createWebSocket(d.data);
    } catch {
      attempt.end("failed");
      return;
    }
    attempt.socket = socket;

    const endFromSocket = (): void => {
      attempt.end(!attempt.opened ? "failed" : attempt.superseded ? "superseded" : "dropped");
    };

    socket.on("open", () => {
      if (attempt.ended) { closeSocket(socket); return; }
      try {
        socket.send(JSON.stringify({ id: 0, method: "Target.setDiscoverTargets", params: { discover: true } }));
      } catch {
        attempt.end("failed");
        return;
      }
      attempt.opened = true;
      console.log("[pi-browser-daemon] Connected to Chrome ✓");
      attempt.settle(true);
    });
    socket.on("message", (data: WebSocket.Data) => {
      if (attempt.ended || !attempt.opened) return;
      events.onMessage(wsDataToString(data));
    });
    socket.on("error", endFromSocket);
    socket.on("close", endFromSocket);
  };

  const isOpen = (): boolean =>
    current !== null && current.opened && current.socket?.readyState === WebSocket.OPEN;

  const connect = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(false);
    if (current) {
      if (!current.opened) return current.settledPromise;
      if (isOpen()) return Promise.resolve(true);
      // Opened once but closing now: Chrome is going away and the close event has not arrived
      // yet. Start a fresh attempt at once; the old socket's close still fails its own requests.
      current.superseded = true;
      current = null;
    }

    const attempt = startAttempt();
    current = attempt;
    run(attempt).catch(() => { attempt.end("failed"); });
    return attempt.settledPromise;
  };

  const start = (): Promise<boolean> => {
    stopped = false;
    return connect();
  };

  const stop = (): void => {
    stopped = true;
    const attempt = current;
    current = null;
    attempt?.end("stopped");
  };

  const send = (payload: string): Result<void, string> => {
    const socket = current?.socket ?? null;
    if (!socket || !isOpen()) return err("Chrome not connected");
    try {
      socket.send(payload);
      return ok(undefined);
    } catch (e) {
      return err(e instanceof Error ? e.message : String(e));
    }
  };

  return {
    start,
    connect,
    isOpen,
    generation: () => current?.generation ?? 0,
    send,
    stop,
  };
};
