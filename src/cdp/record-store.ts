export type DrainPage<T> = {
  readonly records: T[];
  readonly total: number;
  readonly bufferOverflowed: boolean;
};

export type RecordStore<K, T> = {
  set(key: K, rec: T): void;
  get(key: K): T | undefined;
  delete(key: K): void;
  values(): IterableIterator<T>;
  // Takes the overflow flag as it pages, so each drain reports only the loss since the previous one.
  page(matched: T[], limit: number | undefined): DrainPage<T>;
  clear(): void;
};

const MAX_LIMIT = 500;
const DEFAULT_LIMIT = 50;

export const createRecordStore = <K, T>(capacity: number): RecordStore<K, T> => {
  const records = new Map<K, T>();
  let overflowed = false;

  const evictOldestIfFull = (): void => {
    while (records.size >= capacity) {
      const oldest = records.keys().next();
      if (oldest.done) return;
      records.delete(oldest.value);
      overflowed = true;
    }
  };

  return {
    set(key, rec) {
      evictOldestIfFull();
      records.set(key, rec);
    },
    get(key) {
      return records.get(key);
    },
    delete(key) {
      records.delete(key);
    },
    values() {
      return records.values();
    },
    page(matched, limit) {
      const bufferOverflowed = overflowed;
      overflowed = false;
      return {
        records: matched.slice(-Math.min(limit ?? DEFAULT_LIMIT, MAX_LIMIT)),
        total: matched.length,
        bufferOverflowed,
      };
    },
    clear() {
      records.clear();
      overflowed = false;
    },
  };
};
