export const sleep = (ms: number, signal?: AbortSignal): Promise<void> =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("aborted"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });

export type Deadline = {
  readonly remainingMs: () => number;
  readonly expired: () => boolean;
};

export const deadline = (totalMs: number): Deadline => {
  const end = Date.now() + totalMs;
  return {
    remainingMs: () => Math.max(0, end - Date.now()),
    expired: () => Date.now() >= end,
  };
};
