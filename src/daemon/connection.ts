import WebSocket from "ws";
import { discoverWsUrl } from "../cdp/discovery";
import {
  CDP_ATTEMPT_LIFETIME_MS,
  CDP_CONNECT_TIMEOUT_MS,
  CDP_RECONNECT_COOLDOWN_MAX_MS,
  CDP_RECONNECT_COOLDOWN_MS,
} from "./protocol";
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
  // How long connect() waits before answering false while the dial carries on.
  readonly connectTimeoutMs?: number;
  // How long a dial stays open before it is abandoned as failed.
  readonly attemptLifetimeMs?: number;
  readonly cooldownMs?: number;
  readonly cooldownMaxMs?: number;
  readonly onAttemptSettled?: () => void;
  readonly now?: () => number;
};

// What a caller that could not get a connection is looking at.
export type ConnectionStatus =
  | { readonly state: "open" }
  // A dial is in progress; `pendingForMs` says for how long. No new prompt will be opened.
  | { readonly state: "connecting"; readonly pendingForMs: number }
  // The last dial failed; automatic re-dials resume after `retryInMs`.
  | { readonly state: "cooldown"; readonly retryInMs: number; readonly lastFailure: string }
  | { readonly state: "disconnected"; readonly lastFailure: string | null }
  | { readonly state: "stopped" };

export type ChromeConnection = {
  // Clears a previous stop() and dials Chrome. Resolves true once the socket is open.
  readonly start: () => Promise<boolean>;
  // Dials Chrome unless already open, stopped or cooling down. Concurrent callers share the
  // attempt in flight. Resolves true when open, or false once the attempt fails or the caller
  // wait passes; in the latter case the dial itself keeps going.
  readonly connect: () => Promise<boolean>;
  // Explicit human demand: clears the cooldown and backoff, then connect().
  readonly reconnectNow: () => Promise<boolean>;
  readonly status: () => ConnectionStatus;
  readonly isOpen: () => boolean;
  // The generation of the current attempt or open socket; tag requests with it.
  readonly generation: () => number;
  readonly send: (payload: string) => Result<void, string>;
  readonly stop: () => void;
};

type Attempt = {
  readonly generation: number;
  readonly startedAt: number;
  readonly settledPromise: Promise<boolean>;
  socket: ChromeSocket | null;
  opened: boolean;
  ended: boolean;
  superseded: boolean;
  failure: string | null;
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

// Resolves with the attempt's outcome, or false once `waitMs` passes while it is still dialing.
const waitAtMost = (settled: Promise<boolean>, waitMs: number): Promise<boolean> => {
  let timer: ReturnType<typeof setTimeout> | null = null;
  const gaveUp = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => { resolve(false); }, waitMs);
  });
  return Promise.race([settled, gaveUp]).finally(() => {
    if (timer) clearTimeout(timer);
  });
};

// On-demand Chrome connection. Attempts happen only from start(), reconnectNow() and from
// connect() while disconnected; a failed or dropped connection stays disconnected until the
// next explicit browser demand. No background retry loop.
//
// One dial is one "Allow remote debugging" prompt in Chrome, so the design keeps prompts rare:
// a dial lives for attemptLifetimeMs however long callers are willing to wait, every caller
// joins the dial in flight instead of opening another, and after an outright failure no
// automatic dial happens until a doubling cooldown passes. A dropped connection (Chrome closed,
// the machine slept) carries no cooldown: the first re-dial after that is legitimate.
export const createChromeConnection = (
  deps: ChromeConnectionDependencies,
  events: ConnectionEvents,
): ChromeConnection => {
  const {
    discoverWsUrl: discover = discoverWsUrl,
    createWebSocket = (url: string): ChromeSocket => new WebSocket(url, { perMessageDeflate: false }),
    connectTimeoutMs = CDP_CONNECT_TIMEOUT_MS,
    attemptLifetimeMs = CDP_ATTEMPT_LIFETIME_MS,
    cooldownMs = CDP_RECONNECT_COOLDOWN_MS,
    cooldownMaxMs = CDP_RECONNECT_COOLDOWN_MAX_MS,
    onAttemptSettled,
    now = Date.now,
  } = deps;

  let current: Attempt | null = null;
  let stopped = false;
  let lastGeneration = 0;
  let cooldownUntil = 0;
  let nextCooldownMs = cooldownMs;
  let lastFailure: string | null = null;

  const inCooldown = (): boolean => now() < cooldownUntil;

  const recordFailure = (attempt: Attempt): void => {
    lastFailure = attempt.failure ?? "connection attempt failed";
    cooldownUntil = now() + nextCooldownMs;
    nextCooldownMs = Math.min(nextCooldownMs * 2, cooldownMaxMs);
  };

  const recordSuccess = (): void => {
    lastFailure = null;
    cooldownUntil = 0;
    nextCooldownMs = cooldownMs;
  };

  const startAttempt = (): Attempt => {
    const generation = ++lastGeneration;
    let resolveSettled: (opened: boolean) => void = () => undefined;
    const settledPromise = new Promise<boolean>((resolve) => { resolveSettled = resolve; });
    let settled = false;
    // The whole dial, discovery included, is bounded by one lifetime timer.
    let timer: ReturnType<typeof setTimeout> | null = setTimeout(() => {
      attempt.failure ??= `no answer from Chrome within ${Math.round(attemptLifetimeMs / 1000)}s (was its "Allow remote debugging" prompt answered?)`;
      attempt.end("failed");
    }, attemptLifetimeMs);

    const attempt: Attempt = {
      generation,
      startedAt: now(),
      settledPromise,
      socket: null,
      opened: false,
      ended: false,
      superseded: false,
      failure: null,
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
        if (reason === "failed") recordFailure(attempt);
        attempt.settle(false);
        events.onEnd(generation, reason);
      },
    };
    return attempt;
  };

  const run = async (attempt: Attempt): Promise<void> => {
    const d = await discover();
    if (attempt.ended) return;
    if (!d.success) {
      attempt.failure = d.error.message;
      attempt.end("failed");
      return;
    }

    let socket: ChromeSocket;
    try {
      socket = createWebSocket(d.data);
    } catch (e) {
      attempt.failure = e instanceof Error ? e.message : String(e);
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
      } catch (e) {
        attempt.failure = e instanceof Error ? e.message : String(e);
        attempt.end("failed");
        return;
      }
      attempt.opened = true;
      recordSuccess();
      console.log("[pi-browser-daemon] Connected to Chrome ✓");
      attempt.settle(true);
    });
    socket.on("message", (data: WebSocket.Data) => {
      if (attempt.ended || !attempt.opened) return;
      events.onMessage(wsDataToString(data));
    });
    socket.on("error", (e: Error) => {
      attempt.failure ??= e.message;
      endFromSocket();
    });
    socket.on("close", () => {
      attempt.failure ??= "Chrome closed the connection before it opened (was its \"Allow remote debugging\" prompt denied?)";
      endFromSocket();
    });
  };

  const isOpen = (): boolean =>
    current !== null && current.opened && current.socket?.readyState === WebSocket.OPEN;

  const connect = (): Promise<boolean> => {
    if (stopped) return Promise.resolve(false);
    if (current) {
      // A dial in flight is shared: joining it is what keeps Chrome's prompt count at one.
      if (!current.opened) return waitAtMost(current.settledPromise, connectTimeoutMs);
      if (isOpen()) return Promise.resolve(true);
      // Opened once but closing now: Chrome is going away and the close event has not arrived
      // yet. Start a fresh attempt at once; the old socket's close still fails its own requests.
      current.superseded = true;
      current = null;
    }
    if (inCooldown()) return Promise.resolve(false);

    const attempt = startAttempt();
    current = attempt;
    run(attempt).catch((e: unknown) => {
      attempt.failure ??= e instanceof Error ? e.message : String(e);
      attempt.end("failed");
    });
    return waitAtMost(attempt.settledPromise, connectTimeoutMs);
  };

  const start = (): Promise<boolean> => {
    stopped = false;
    return connect();
  };

  const reconnectNow = (): Promise<boolean> => {
    recordSuccess();
    return start();
  };

  const stop = (): void => {
    stopped = true;
    const attempt = current;
    current = null;
    attempt?.end("stopped");
  };

  const status = (): ConnectionStatus => {
    if (stopped) return { state: "stopped" };
    if (isOpen()) return { state: "open" };
    if (current && !current.opened) return { state: "connecting", pendingForMs: now() - current.startedAt };
    if (inCooldown() && lastFailure !== null) return { state: "cooldown", retryInMs: cooldownUntil - now(), lastFailure };
    return { state: "disconnected", lastFailure };
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
    reconnectNow,
    status,
    isOpen,
    generation: () => current?.generation ?? 0,
    send,
    stop,
  };
};
