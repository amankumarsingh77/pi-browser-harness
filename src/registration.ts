// Pi re-invokes an extension factory for every session runtime while keeping the ES module
// cached. Registration bookkeeping therefore belongs to the pi API object for that runtime,
// not to the module: a new runtime must register the full tool list again, while repeated
// session_start calls on the same runtime must not duplicate it.
export type RegistrationTracker = {
  readonly isRegistered: (pi: object, name: string) => boolean;
  readonly markRegistered: (pi: object, name: string) => void;
};

export const createRegistrationTracker = (): RegistrationTracker => {
  const registeredByApi = new WeakMap<object, Set<string>>();
  const namesFor = (pi: object): Set<string> => {
    let names = registeredByApi.get(pi);
    if (!names) {
      names = new Set<string>();
      registeredByApi.set(pi, names);
    }
    return names;
  };
  return {
    isRegistered: (pi, name) => namesFor(pi).has(name),
    markRegistered: (pi, name) => {
      namesFor(pi).add(name);
    },
  };
};

/**
 * Register each tool once for `pi`. A tool is marked only after its register callback returns,
 * so a failure leaves it (and every tool after it) available to the next attempt.
 */
export const registerTools = <T extends { readonly name: string }>(
  tracker: RegistrationTracker,
  pi: object,
  tools: ReadonlyArray<T>,
  register: (tool: T) => void,
): void => {
  for (const tool of tools) {
    if (tracker.isRegistered(pi, tool.name)) continue;
    register(tool);
    tracker.markRegistered(pi, tool.name);
  }
};
