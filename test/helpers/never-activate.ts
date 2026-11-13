import { setNeverActivate } from "../../src/util/activation";

// The policy is process-wide state; a test turns it on for one body and always puts it back.
export const underNeverActivate = async <T>(fn: () => Promise<T>): Promise<T> => {
  setNeverActivate(true);
  try {
    return await fn();
  } finally {
    setNeverActivate(false);
  }
};
