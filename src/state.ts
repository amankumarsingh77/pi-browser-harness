/**
 * Session persistence for pi-browser-harness.
 *
 * Persists daemon namespace, tab history, and preferences across
 * session reloads and branch navigation.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";

// ── Types ────────────────────────────────────────────────────────────────────

export interface BrowserState {
  /** Daemon namespace (BU_NAME) for this session */
  namespace: string;
  /** Recently active tab target IDs */
  tabHistory: string[];
  /** Cloud browser ID (for remote sessions) */
  remoteBrowserId?: string;
  /** Screenshot output directory */
  screenshotDir: string;
  /** Whether debug click overlay is enabled */
  debugClicks: boolean;
}

// ── Defaults ─────────────────────────────────────────────────────────────────

export function defaultState(namespace = "default"): BrowserState {
  return {
    namespace,
    tabHistory: [],
    screenshotDir: "",
    debugClicks: false,
  };
}

// ── Persist ──────────────────────────────────────────────────────────────────

export function persistState(pi: ExtensionAPI, state: BrowserState): void {
  pi.appendEntry<BrowserState>("browser-harness-state", state);
}

// ── Restore ──────────────────────────────────────────────────────────────────

/**
 * Find the last browser-harness-state entry in the current branch
 * and return the restored state, merged with defaults.
 */
export function restoreState(ctx: ExtensionContext, currentNamespace?: string): BrowserState {
  const branchEntries = ctx.sessionManager.getBranch();
  const defaults = defaultState(currentNamespace);

  // Walk branch from newest to oldest to find last persisted state
  for (let i = branchEntries.length - 1; i >= 0; i--) {
    const entry = branchEntries[i];
    if (entry.type === "custom" && entry.customType === "browser-harness-state") {
      const data = entry.data as Partial<BrowserState> | undefined;
      if (data) {
        // Merge persisted data onto defaults, but always keep the current
        // namespace (which comes from the --browser-namespace flag or auto-gen).
        return { ...defaults, ...data, namespace: currentNamespace || data.namespace || defaults.namespace };
      }
    }
  }

  return defaults;
}

// ── Merge helpers ────────────────────────────────────────────────────────────

export function addToTabHistory(state: BrowserState, targetId: string): BrowserState {
  const filtered = state.tabHistory.filter((id) => id !== targetId);
  return { ...state, tabHistory: [targetId, ...filtered].slice(0, 20) };
}

export function setRemoteBrowser(state: BrowserState, browserId: string): BrowserState {
  return { ...state, remoteBrowserId: browserId };
}
