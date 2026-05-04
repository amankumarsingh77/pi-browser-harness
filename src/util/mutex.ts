/**
 * Lightweight async mutex (~10 lines). Acquire returns a release function.
 * When the mutex is free, acquire() resolves immediately. When held,
 * callers are queued and execute serially in FIFO order.
 */
export type Mutex = {
  acquire(): Promise<() => void>;
};

export const createMutex = (): Mutex => {
  let queue = Promise.resolve<unknown>(undefined);

  return {
    async acquire(): Promise<() => void> {
      let release = () => {};
      const next = new Promise<void>((resolve) => {
        release = resolve;
      });
      const prev = queue;
      queue = prev.then(() => next);
      await prev;
      return release;
    },
  };
};
