export type OwnershipRegistry = {
  add(targetId: string): void;
  remove(targetId: string): void;
  has(targetId: string): boolean;
  list(): ReadonlyArray<string>;
  replaceAll(ids: ReadonlyArray<string>): void;
  setHarnessWindow(targetId: string | undefined): void;
  harnessWindow(): string | undefined;
  setHarnessWindowId(windowId: number | undefined): void;
  harnessWindowId(): number | undefined;
  onChange(cb: () => void): void;
};

export const createOwnershipRegistry = (
  initial?: {
    readonly ownedTargetIds?: ReadonlyArray<string>;
    readonly harnessWindowTargetId?: string;
    readonly harnessWindowId?: number;
  },
): OwnershipRegistry => {
  const owned = new Set<string>(initial?.ownedTargetIds ?? []);
  let harnessWindow: string | undefined = initial?.harnessWindowTargetId;
  let harnessWindowId: number | undefined = initial?.harnessWindowId;
  let listener: (() => void) | null = null;

  const notify = (): void => {
    if (listener) listener();
  };

  return {
    add(targetId) {
      if (owned.has(targetId)) return;
      owned.add(targetId);
      notify();
    },
    remove(targetId) {
      if (!owned.has(targetId) && harnessWindow !== targetId) return;
      owned.delete(targetId);
      if (harnessWindow === targetId) harnessWindow = undefined;
      notify();
    },
    has(targetId) {
      return owned.has(targetId);
    },
    list() {
      return [...owned];
    },
    replaceAll(ids) {
      owned.clear();
      for (const id of ids) owned.add(id);
      notify();
    },
    setHarnessWindow(targetId) {
      if (harnessWindow === targetId) return;
      harnessWindow = targetId;
      notify();
    },
    harnessWindow() {
      return harnessWindow;
    },
    setHarnessWindowId(windowId) {
      if (harnessWindowId === windowId) return;
      harnessWindowId = windowId;
      notify();
    },
    harnessWindowId() {
      return harnessWindowId;
    },
    onChange(cb) {
      listener = cb;
    },
  };
};
