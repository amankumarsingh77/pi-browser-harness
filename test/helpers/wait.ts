import { setTimeout as sleep } from "node:timers/promises";

// Polls `predicate` every few milliseconds until it holds or the budget runs out; the final check is reported.
export const waitFor = async (predicate: () => boolean, timeoutMs = 1_000): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return true;
    await sleep(2);
  }
  return predicate();
};
