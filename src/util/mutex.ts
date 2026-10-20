export type Mutex = {
  acquire(): Promise<() => void>;
};

export const createMutex = (): Mutex => {
  let queue = Promise.resolve<unknown>(undefined);

  return {
    async acquire(): Promise<() => void> {
      let release: () => void = () => undefined;
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
