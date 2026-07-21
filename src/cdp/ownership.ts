/**
 * Tracks which tab targetIds belong to this harness session.
 *
 * The harness attaches to the user's running Chrome, which is also full of
 * the user's own tabs. Without an ownership boundary the agent could attach
 * to (or close) personal tabs by accident. The registry is the single source
 * of truth for "did this session open that tab?".
 *
 * Mutations notify a single change listener so the orchestrator can persist
 * to disk via the existing BrowserState flow without the registry needing to
 * know about the pi storage API.
 */

export type OwnershipRegistry = {
  add(targetId: string): void;
  remove(targetId: string): void;
  has(targetId: string): boolean;
  list(): ReadonlyArray<string>;
  /** Replace the full set — used on restoreState to re-hydrate from disk. */
  replaceAll(ids: ReadonlyArray<string>): void;
  setHarnessWindow(targetId: string | undefined): void;
  harnessWindow(): string | undefined;
  /** The real Chrome windowId of the dedicated harness window — the durable
   *  identity of "the window this session initialized", surviving seed-tab
   *  closure. Undefined until the window is created (or after teardown). */
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
