import type { CdpEvent } from "./types";

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
