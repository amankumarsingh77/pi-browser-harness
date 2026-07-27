/**
 * Session persistence for pi-browser-harness.
 *
 * Persists the daemon namespace and (when applicable) the remote browser ID
 * across session reloads and branch navigation.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { asArrayOf, asNumber, asString, isRecord } from "./util/guards";

export type BrowserState = {
  readonly namespace: string;
  readonly remoteBrowserId?: string;
  readonly ownedTargetIds?: ReadonlyArray<string>;
  readonly harnessWindowTargetId?: string;
  readonly harnessWindowId?: number;
};

export const defaultState = (namespace = "default"): BrowserState => ({
  namespace,
  ownedTargetIds: [],
});

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
const asPersistedState = (v: unknown): Partial<BrowserState> | undefined => {
  if (!isRecord(v)) return undefined;
  const namespace = asString(v["namespace"]);
  const remoteBrowserId = asString(v["remoteBrowserId"]);
  const ownedTargetIds = asArrayOf(v["ownedTargetIds"], asString);
  const harnessWindowTargetId = asString(v["harnessWindowTargetId"]);
  const harnessWindowId = asNumber(v["harnessWindowId"]);
  return {
    ...(namespace !== undefined ? { namespace } : {}),
    ...(remoteBrowserId !== undefined ? { remoteBrowserId } : {}),
    ...(ownedTargetIds !== undefined ? { ownedTargetIds } : {}),
    ...(harnessWindowTargetId !== undefined ? { harnessWindowTargetId } : {}),
    ...(harnessWindowId !== undefined ? { harnessWindowId } : {}),
  };
};

export const restoreState = (ctx: ExtensionContext, currentNamespace?: string): BrowserState => {
  const branchEntries = ctx.sessionManager.getBranch();
  const fallback = defaultState(currentNamespace);
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i];
    if (entry?.type === "custom" && entry.customType === "browser-harness-state") {
      const data = asPersistedState(entry.data);
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
