import { type Result, err } from "../util/result";
import { type CdpError, cdpError } from "./errors";
import type { CdpEvent } from "./types";

export type CdpResult = Result<unknown, CdpError>;

export type EventQueue = {
  readonly push: (e: CdpEvent) => void;
  readonly end: () => void;
  readonly iter: AsyncIterable<CdpEvent>;
};

export const makeEventQueue = (): EventQueue => {
  const buf: CdpEvent[] = [];
  const waiters: Array<(v: IteratorResult<CdpEvent, undefined>) => void> = [];
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
      for (const w of waiters.splice(0)) w({ value: undefined, done: true });
    },
    iter: {
      [Symbol.asyncIterator](): AsyncIterator<CdpEvent, undefined, undefined> {
        return {
          next: (): Promise<IteratorResult<CdpEvent, undefined>> =>
            new Promise((resolve) => {
              const next = buf.shift();
              if (next) resolve({ value: next, done: false });
              else if (ended) resolve({ value: undefined, done: true });
              else waiters.push(resolve);
            }),
        };
      },
    },
  };
};

export type Pending = {
  readonly resolve: (v: Result<unknown, CdpError>) => void;
  readonly timer: ReturnType<typeof setTimeout>;
  readonly method: string;
};

export const rejectAllPending = (pending: Map<number, Pending>, reason: string): void => {
  for (const [, p] of pending) {
    clearTimeout(p.timer);
    p.resolve(err(cdpError("transport_closed", reason, p.method)));
  }
  pending.clear();
};

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

export const makeOnClose = (closeListeners: Set<() => void>) =>
  (cb: () => void): (() => void) => {
    closeListeners.add(cb);
    return () => closeListeners.delete(cb);
  };
