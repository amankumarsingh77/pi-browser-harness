import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { asArrayOf, asNumber, asString, isRecord } from "./util/guards";

export type BrowserState = {
  readonly namespace: string;
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

const asPersistedState = (v: unknown): Partial<BrowserState> | undefined => {
  if (!isRecord(v)) return undefined;
  const namespace = asString(v["namespace"]);
  const ownedTargetIds = asArrayOf(v["ownedTargetIds"], asString);
  const harnessWindowTargetId = asString(v["harnessWindowTargetId"]);
  const harnessWindowId = asNumber(v["harnessWindowId"]);
  return {
    ...(namespace !== undefined ? { namespace } : {}),
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
