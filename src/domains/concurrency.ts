// A bounded fan-out runner: at most `limit` tasks in flight, nothing started once `signal` aborts, and a task
// still running at abort time is abandoned (its slot resolves to undefined) so the caller returns on the deadline.
export const runLimited = async <T, R>(
  items: ReadonlyArray<T>,
  opts: { readonly limit: number; readonly signal: AbortSignal },
  fn: (item: T, signal: AbortSignal) => Promise<R>,
): Promise<ReadonlyArray<R | undefined>> => {
  const out: Array<R | undefined> = items.map(() => undefined);
  const { signal } = opts;
  const aborted = new Promise<undefined>((resolve) => {
    if (signal.aborted) resolve(undefined);
    else signal.addEventListener("abort", () => { resolve(undefined); }, { once: true });
  });
  const queue = items.entries();
  const worker = async (): Promise<void> => {
    for (;;) {
      const next = queue.next();
      if (next.done) return;
      const [i, item] = next.value;
      if (signal.aborted) continue;
      try {
        out[i] = await Promise.race([fn(item, signal), aborted]);
      } catch {
        out[i] = undefined;
      }
    }
  };
  const workers = Array.from({ length: Math.max(1, Math.min(opts.limit, items.length)) }, worker);
  await Promise.all(workers);
  return out;
};

// A signal that fires after `ms`, or earlier if `parent` aborts; `clear` releases the timer once the work is done.
export const deadlineSignal = (
  ms: number,
  parent?: AbortSignal,
): { readonly signal: AbortSignal; readonly clear: () => void } => {
  const ac = new AbortController();
  const onParentAbort = (): void => { ac.abort(); };
  const timer = setTimeout(() => { ac.abort(); }, ms);
  if (parent?.aborted) ac.abort();
  else parent?.addEventListener("abort", onParentAbort, { once: true });
  return {
    signal: ac.signal,
    clear: () => {
      clearTimeout(timer);
      parent?.removeEventListener("abort", onParentAbort);
    },
  };
};
