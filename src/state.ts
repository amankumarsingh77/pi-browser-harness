/**
 * Session persistence for pi-browser-harness.
 *
 * Persists the daemon namespace and (when applicable) the remote browser ID
 * across session reloads and branch navigation.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

export type BrowserState = {
  readonly namespace: string;
  readonly remoteBrowserId?: string;
};

export const defaultState = (namespace = "default"): BrowserState => ({ namespace });

export const persistState = (pi: ExtensionAPI, state: BrowserState): void => {
  pi.appendEntry<BrowserState>("browser-harness-state", state);
};

/**
 * Find the last browser-harness-state entry in the current branch
 * and return the restored state, merged with defaults.
 *
 * If `currentNamespace` is supplied (e.g. from the --browser-namespace flag),
 * it overrides whatever is in the persisted entry.
 */
export const restoreState = (ctx: ExtensionContext, currentNamespace?: string): BrowserState => {
  const branchEntries = ctx.sessionManager.getBranch();
  const fallback = defaultState(currentNamespace);
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i];
    if (entry?.type === "custom" && entry.customType === "browser-harness-state") {
      const data = entry.data as Partial<BrowserState> | undefined;
      if (data) {
        return {
          ...fallback,
          ...data,
          namespace: currentNamespace ?? data.namespace ?? fallback.namespace,
        };
      }
    }
  }
  return fallback;
};
