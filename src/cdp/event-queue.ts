/**
 * Shared transport primitives for CdpTransport implementations.
 *
 * Both the WebSocket transport (transport.ts, talking to Chrome directly) and
 * the daemon transport (daemon-transport.ts, talking to the daemon over a Unix
 * socket) need an identical single-consumer async event queue plus the same
 * pending-request bookkeeping. This module is the single source of truth for
 * that shared machinery.
 */

import { type Result, err } from "../util/result";
import { type CdpError, cdpError } from "./errors";
import type { CdpEvent } from "./types";

export type CdpResult = Result<unknown, CdpError>;

/**
 * A single-consumer async queue of CDP events.
 *
 * `push` enqueues an event (dropped silently after `end`). `end` terminates the
 * stream — any pending and future iterator `next()` calls resolve `done:true`.
 * `iter` is the AsyncIterable consumed by one for-await loop; a second consumer
 * would silently steal events from the first.
 */
export type EventQueue = {
  readonly push: (e: CdpEvent) => void;
  readonly end: () => void;
  readonly iter: AsyncIterable<CdpEvent>;
};

export const makeEventQueue = (): EventQueue => {
  const buf: CdpEvent[] = [];
  const waiters: Array<(v: IteratorResult<CdpEvent>) => void> = [];
  let ended = false;
  return {
    push(e) {
      if (ended) return;
      const w = waiters.shift();
      if (w) w({ value: e, done: false });
      else buf.push(e);
    },
    end() {
      ended = true;
      // value: undefined as unknown as CdpEvent is the correct iterator-protocol
      // pattern: when done=true the value field is conventionally undefined but
      // the TS type still requires CdpEvent.
      for (const w of waiters.splice(0)) w({ value: undefined as unknown as CdpEvent, done: true });
    },
    iter: {
      [Symbol.asyncIterator]() {
        return {
          next: (): Promise<IteratorResult<CdpEvent>> =>
            new Promise((resolve) => {
              const next = buf.shift();
              if (next) resolve({ value: next, done: false });
              else if (ended) resolve({ value: undefined as unknown as CdpEvent, done: true });
              else waiters.push(resolve);
            }),
        };
      },
    },
  };
};

/** An in-flight CDP request awaiting its response or timeout. */
export type Pending = {
  readonly resolve: (v: Result<unknown, CdpError>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly method: string;
};

/**
 * Reject every in-flight request with a transport_closed error and clear the
 * map. Called from each transport's cleanup path when the underlying connection
 * goes away.
 */
export const rejectAllPending = (pending: Map<number, Pending>, reason: string): void => {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve(err(cdpError("transport_closed", reason, p.method)));
  }
  pending.clear();
};

/**
 * Send a CDP request and return a promise that settles when the matching
 * response arrives, the request times out, or the send throws.
 *
 * The transport supplies a `send` callback that puts the already-serialized
 * payload onto its wire (WebSocket frame or Unix-socket line); everything else
 * — registering the pending entry, the timeout timer, and synchronous send
 * failure handling — is identical across transports and lives here.
 *
 * `timeoutLabel` is the transport's prefix for the timeout error message
 * (e.g. "CDP" or "Daemon").
 */
export const sendWithTimeout = (
  pending: Map<number, Pending>,
  id: number,
  method: string,
  timeoutMs: number,
  timeoutLabel: string,
  send: () => void,
): Promise<CdpResult> =>
  new Promise((resolve) => {
    const timer = setTimeout(() => {
      pending.delete(id);
      resolve(err(cdpError("timeout", `${timeoutLabel} timeout after ${timeoutMs}ms: ${method}`, method)));
    }, timeoutMs);
    pending.set(id, { resolve, timer, method });
    try {
      send();
    } catch (e) {
      clearTimeout(timer);
      pending.delete(id);
      resolve(err(cdpError("transport_closed", e instanceof Error ? e.message : String(e), method)));
    }
  });

/**
 * Register a close listener, returning an unsubscribe function. Identical
 * across transports, so it lives here.
 */
export const makeOnClose = (closeListeners: Set<() => void>) =>
  (cb: () => void): (() => void) => {
    closeListeners.add(cb);
    return () => closeListeners.delete(cb);
  };
