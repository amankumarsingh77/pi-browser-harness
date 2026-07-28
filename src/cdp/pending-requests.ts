import { type Result, err } from "../util/result";
import { type CdpError, cdpError } from "./errors";

export type CdpResult = Result<unknown, CdpError>;

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
