---
date: 2026-05-07T18:15:35Z
author: amankumarsingh77
commit: 4052e6e
branch: main
repository: pi-browser-harness
topic: "per-tab-isolation-multi-agent-safety"
tags: [plan, session, isolation, per-tab, buffers, dialog, safety, concurrency]
status: ready
parent: "thoughts/shared/designs/2026-05-07_00-58_per-tab-isolation.md"
last_updated: 2026-05-07T18:15:35Z
last_updated_by: amankumarsingh77
---

# Per-Tab Isolation for Multi-Agent Safety — Implementation Plan

## Overview

Implement per-tab data isolation in `pi-browser-harness` so that multiple subagents can use the browser without corrupting each other's state. Replace singleton dialog, page-info-dirty flag, network buffer, and console buffer with per-tab `TabSession` objects stored in a `Map<string, TabSession>`. Add an `ev.sessionId` filter in the CDP event consumer to prevent cross-tab event contamination. Deliverable in 3 sequential phases totaling 4 file modifications.

Reference design: `thoughts/shared/designs/2026-05-07_00-58_per-tab-isolation.md`

## Desired End State

Tab A and Tab B can coexist without cross-contamination:

- Switching tabs preserves each tab's network/console buffer data (no `clear()` on switch)
- Dialog from tab A is not overwritten by dialog from tab B
- Page info dirty flag is per-tab, not global
- Console `sinceSeq` cursor remains valid across tab switches (no cross-tab data leaks)
- Page info cache is preserved per-tab across switches
- CDP events from unattached sessions are filtered (no cross-contamination)
- Dead tab state is pruned on target destruction and session reconciliation

## What We're NOT Doing

- Agent-aware tab locking (requires pi platform agent identity exposure — Phase 3, deferred)
- Observation tool `callOnTarget` refactoring (Phase 3, deferred)
- Per-agent BrowserClient instances
- New CDP transport connections per agent

## Phase 1: Foundation — TabSession type, Maps, ev.sessionId filter, switchTo rework

### Overview
Introduces the `TabSession` type, the `Map<string, TabSession>` collection, the `sessionIdToTargetId` reverse lookup, the 1-line `ev.sessionId` guard in `consumeEvents`, and the `switchTo` rework that creates/reuses `TabSession` without clearing buffers. This phase alone prevents cross-tab event contamination and is independently shippable.

### Changes Required:

#### 1. TabSession type + infrastructure (`src/cdp/session.ts`)
**File**: `src/cdp/session.ts`
**Changes**: Insert `TabSession` type definition before `createCdpSession`. Inside `createCdpSession`, add `tabs` Map, `sessionIdToTargetId` Map. Add `ev.sessionId` filter in `consumeEvents`. Rework `switchTo` to create/reuse `TabSession`. Update `attachFirstPage` to create initial `TabSession`. Add Map cleanup in `transport.onClose`.

```typescript
// === Phase 1: Foundation ===

// NEW: Per-tab state type (inserted before createCdpSession, after imports)
type TabSession = {
  sessionId: string;
  targetId: string;
  dialog: DialogInfo | null;
  pageInfoDirty: boolean;
  networkBuffer: ReturnType<typeof createNetworkBuffer>;
  consoleBuffer: ReturnType<typeof createConsoleBuffer>;
};

// Inside createCdpSession(), ADD after the singleton declarations:
const tabs = new Map<string, TabSession>();
const sessionIdToTargetId = new Map<string, string>();

// consumeEvents — ADD filter guard as the FIRST statement inside the for-await loop
// (inserted before the existing `if (ev.method === "Page.javascriptDialogOpening")`)
for await (const ev of transport.events()) {
  // Filter: skip events from sessions we're not currently tracking.
  // Target.targetDestroyed is browser-level (no sessionId) — always process.
  if (ev.method !== "Target.targetDestroyed") {
    if (ev.sessionId && ev.sessionId !== sessionId) continue;
  }
  // ... all existing event handlers unchanged ...
}

// switchTo — REPLACE the entire method body:
async switchTo(tid) {
  const activated = await transport.request("Target.activateTarget", { targetId: tid }, { sessionId: null });
  if (!activated.success) return activated;
  const attached = await transport.request("Target.attachToTarget", { targetId: tid, flatten: true }, { sessionId: null });
  if (!attached.success) return attached;
  const a = attached.data as { sessionId: string };
  // Reuse existing TabSession or create one on first visit
  const existing = tabs.get(tid);
  const tab: TabSession = existing ?? {
    sessionId: a.sessionId,
    targetId: tid,
    dialog: null,
    pageInfoDirty: true,
    networkBuffer: createNetworkBuffer(),
    consoleBuffer: createConsoleBuffer(),
  };
  if (!existing) {
    tabs.set(tid, tab);
    await enableDomains(a.sessionId);
  }
  // Update global pointers to point at the new active tab
  sessionId = tab.sessionId;
  targetId = tid;
  // Update sessionId→targetId reverse lookup for event filtering
  sessionIdToTargetId.set(tab.sessionId, tid);
  return ok(undefined);
}

// attachFirstPage — ADD after `sessionId = a.sessionId; targetId = pickTargetId;`:
tabs.set(pickTargetId, {
  sessionId: a.sessionId,
  targetId: pickTargetId,
  dialog: null,
  pageInfoDirty: false,
  networkBuffer: createNetworkBuffer(),
  consoleBuffer: createConsoleBuffer(),
});
sessionIdToTargetId.set(a.sessionId, pickTargetId);

// transport.onClose — ADD Map cleanup before restartConsumer():
tabs.clear();
sessionIdToTargetId.clear();
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run typecheck`
- [x] `grep -c "consumeEvents" src/cdp/session.ts` confirms single consumer
- [x] `grep "ev.sessionId && ev.sessionId !== sessionId" src/cdp/session.ts` confirms filter guard exists

#### Manual Verification:
- [x] Run `scripts/test-parallel.ts` — parallel mutation tests still pass (mutex unchanged)
- [ ] Open two tabs via `browser_new_tab`, switch between them — no crash, session alive
- [ ] CDP events from non-current tabs are silently dropped (verify: navigate tab A, switch to tab B, network events from tab A don't appear in `browser_network_requests`)

---

## Phase 2: State Migration — Singletons into TabSession + per-tab page cache + nextSeq fix

### Overview
Moves `dialog`, `pageInfoDirty`, `networkBuffer`, and `consoleBuffer` from singleton variables into `TabSession`. `consumeEvents` routes events to the correct tab's buffer. `takeDialog()`, `drainPageInfoInvalidations()`, `drainNetworkBuffer()`, `drainConsoleBuffer()` all read from the current `TabSession`. `client.ts` `pageCache` becomes `Map<targetId, Cache>`. `console-buffer.ts` `clear()` resets `nextSeq` to 1.

### Changes Required:

#### 1. Dialog + dirty flag into TabSession (`src/cdp/session.ts`)
**File**: `src/cdp/session.ts`
**Changes**: Route dialog handler and dirty-flag handler through `TabSession`. Replace `takeDialog()` and `drainPageInfoInvalidations()` to read from current tab. Remove singleton `dialog` and `pageInfoDirty` declarations.

```typescript
// === Phase 2a: Dialog + dirty flag ===

// consumeEvents — dialog handler: write to TabSession instead of singleton
if (ev.method === "Page.javascriptDialogOpening") {
  const tab = targetId ? tabs.get(targetId) : undefined;
  if (!tab) continue;
  const params = ev.params as Partial<DialogInfo> | undefined;
  tab.dialog = {
    type: (params?.type as DialogInfo["type"]) ?? "alert",
    message: params?.message ?? "",
    ...(params?.defaultPrompt !== undefined ? { defaultPrompt: params.defaultPrompt } : {}),
  };
  continue;
}

// consumeEvents — dirty flag: write to TabSession instead of singleton
if (ev.method === "Page.frameNavigated" || ev.method === "Page.loadEventFired") {
  const tab = targetId ? tabs.get(targetId) : undefined;
  if (tab) tab.pageInfoDirty = true;
}

// takeDialog — read from current TabSession
takeDialog() {
  const tab = targetId ? tabs.get(targetId) : undefined;
  if (!tab) return null;
  const d = tab.dialog;
  tab.dialog = null;
  return d;
},

// drainPageInfoInvalidations — read from current TabSession
drainPageInfoInvalidations() {
  const tab = targetId ? tabs.get(targetId) : undefined;
  if (!tab) return false;
  const dirty = tab.pageInfoDirty;
  tab.pageInfoDirty = false;
  return dirty;
},

// REMOVE the singleton `dialog` and `pageInfoDirty` declarations:
// - let dialog: DialogInfo | null = null;  ← REMOVED (now in TabSession)
// - let pageInfoDirty = false;             ← REMOVED (now in TabSession)
```

#### 2. Buffer routing + drain from TabSession (`src/cdp/session.ts`)
**File**: `src/cdp/session.ts`
**Changes**: Add `resolveTab` helper. Route all network/console event handlers through `resolveTab`. Replace `drainNetworkBuffer()` and `drainConsoleBuffer()` to read from current `TabSession`. Remove singleton `networkBuffer` and `consoleBuffer` declarations.

```typescript
// === Phase 2b: Buffer routing + drain ===

// consumeEvents — route network/console events to correct TabSession:
// Helper (inserted before the for-await loop):
const resolveTab = (evSessionId?: string): TabSession | undefined => {
  const tid = evSessionId ? sessionIdToTargetId.get(evSessionId) : targetId;
  return tid ? tabs.get(tid) : undefined;
};

// Replace all singleton buffer ingest calls with routed calls:
if (ev.method === "Network.requestWillBeSent") {
  const tab = resolveTab(ev.sessionId);
  if (tab) tab.networkBuffer.ingestRequestWillBeSent(ev.params);
}
else if (ev.method === "Network.responseReceived") {
  const tab = resolveTab(ev.sessionId);
  if (tab) tab.networkBuffer.ingestResponseReceived(ev.params);
}
else if (ev.method === "Network.loadingFinished") {
  const tab = resolveTab(ev.sessionId);
  if (tab) tab.networkBuffer.ingestLoadingFinished(ev.params);
}
else if (ev.method === "Network.loadingFailed") {
  const tab = resolveTab(ev.sessionId);
  if (tab) tab.networkBuffer.ingestLoadingFailed(ev.params);
}
else if (ev.method === "Runtime.consoleAPICalled") {
  const tab = resolveTab(ev.sessionId);
  if (tab) tab.consoleBuffer.ingestConsoleApi(ev.params);
}
else if (ev.method === "Log.entryAdded") {
  const tab = resolveTab(ev.sessionId);
  if (tab) tab.consoleBuffer.ingestLogEntry(ev.params);
}

// drainNetworkBuffer — read from current TabSession
drainNetworkBuffer(filter) {
  const tab = targetId ? tabs.get(targetId) : undefined;
  if (!tab) return { records: [], total: 0, bufferOverflowed: false };
  return tab.networkBuffer.drain(filter);
},

// drainConsoleBuffer — read from current TabSession
drainConsoleBuffer(filter) {
  const tab = targetId ? tabs.get(targetId) : undefined;
  if (!tab) return { records: [], total: 0, bufferOverflowed: false };
  return tab.consoleBuffer.drain(filter);
},

// REMOVE the singleton buffer declarations:
// - const networkBuffer = createNetworkBuffer();  ← REMOVED (now in TabSession)
// - const consoleBuffer = createConsoleBuffer();   ← REMOVED (now in TabSession)
```

#### 3. nextSeq reset on clear (`src/cdp/console-buffer.ts`)
**File**: `src/cdp/console-buffer.ts`
**Changes**: Replace the `clear()` method body to reset `nextSeq` to 1.

```typescript
// Replace the clear() method body — reset nextSeq to 1 on clear:
    clear() {
      records.clear();
      nextSeq = 1;
      overflowed = false;
    },
```

#### 4. Per-tab page cache (`src/client.ts`)
**File**: `src/client.ts`
**Changes**: Replace single `pageCache` with `Map<targetId, Cache>`. Update `readPageInfo`, `switchTab`, and `stop`.

```typescript
// REPLACE single pageCache with per-tab Map:
const pageCaches = new Map<string, { readonly info: PageInfo; readonly at: number }>();

// readPageInfo — use per-tab Map instead of singleton:
const readPageInfo = async (): Promise<Result<PageInfo, CdpError>> => {
  const dirty = session.drainPageInfoInvalidations();
  const currentTid = session.current()?.targetId;
  const cached = currentTid ? pageCaches.get(currentTid) : undefined;
  if (cached && !dirty && Date.now() - cached.at < PAGE_INFO_TTL_MS)
    return ok(cached.info);
  const expr = safeJs`JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})`;
  const raw = await evaluateJs(expr);
  if (!raw.success) return raw;
  if (typeof raw.data !== "string") return err(cdpError("invalid_response", "page info evaluation did not return a string"));
  let parsedRaw: unknown;
  try {
    parsedRaw = JSON.parse(raw.data);
  } catch (e) {
    return err(cdpError("invalid_response", `page info JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`));
  }
  const info = parsePageInfoPayload(parsedRaw);
  if (!info.success) return info;
  if (currentTid) pageCaches.set(currentTid, { info: info.data, at: Date.now() });
  return ok(info.data);
};

// switchTab — REMOVE `pageCache = null` (no longer needed — each tab retains its cache):
const switchTab = async (targetId: string): Promise<Result<void, CdpError>> => {
  const r = await session.switchTo(targetId);
  if (!r.success) return r;
  // pageCache = null;  ← REMOVED
  await session.call("Runtime.evaluate", {
    expression: safeJs`if(!document.title.startsWith('🟢'))document.title='🟢 '+document.title`,
  });
  return ok(undefined);
};

// stop — REMOVE `pageCache = null`, replace with Map.clear():
const stop = async (): Promise<void> => {
  await transport.close();
  pageCaches.clear();
  lastHealth = 0;
};
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run typecheck`
- [x] `grep "let dialog" src/cdp/session.ts` returns no matches (singleton removed)
- [x] `grep "let pageInfoDirty" src/cdp/session.ts` returns no matches
- [x] `grep "const networkBuffer" src/cdp/session.ts` returns no matches
- [x] `grep "const consoleBuffer" src/cdp/session.ts` returns no matches
- [x] `grep "nextSeq = 1" src/cdp/console-buffer.ts` confirms the change
- [x] `grep "pageCaches" src/client.ts` confirms Map usage

#### Manual Verification:
- [ ] Run `scripts/test-parallel.ts` — all tests pass
- [ ] Run `scripts/test-parallel-integration.ts` — all tests pass
- [ ] Open tab A, trigger `browser_console`, note `nextCursor`. Switch to tab B, trigger `browser_console`. Switch back to tab A, call `browser_console({ sinceSeq: <tabA_cursor> })` — returns only new tab A messages (not tab B's)
- [ ] Navigate tab A to a page with an alert. Switch to tab B BEFORE calling `browser_page_info`. Call `browser_page_info` on tab B — returns tab B's page info (NOT tab A's dialog)
- [ ] Tab A navigates (triggering pageInfoDirty). Switch to tab B, call `browser_page_info` twice within 1 second — second call uses tab B's cache (not invalidated by tab A's navigation)

---

## Phase 3: Cleanup + Reconciliation + Prompt

### Overview
`Target.targetDestroyed` handler removes `TabSession` entries. `attachFirstPage` and `listTabs` prune dead `TabSession` and `pageCaches` entries during reconciliation. `prompt.ts` "Parallel Execution" section gains a multi-agent warning.

### Changes Required:

#### 1. TabSession cleanup on target destruction + reconciliation (`src/cdp/session.ts`)
**File**: `src/cdp/session.ts`
**Changes**: Extend `Target.targetDestroyed` handler to remove TabSession entries. Add TabSession pruning loop in `attachFirstPage` reconciliation.

```typescript
// === Phase 3a: TabSession cleanup ===

// consumeEvents — Target.targetDestroyed: remove TabSession entries
if (ev.method === "Target.targetDestroyed" && ownership) {
  const params = ev.params as { targetId?: string } | undefined;
  if (params?.targetId) {
    ownership.remove(params.targetId);
    // Prune per-tab state for the destroyed target
    const tab = tabs.get(params.targetId);
    if (tab) {
      sessionIdToTargetId.delete(tab.sessionId);
      tabs.delete(params.targetId);
    }
  }
}

// attachFirstPage — ADD TabSession pruning after ownership reconciliation:
const liveTargetIds = new Set(allPages.map((p) => p.targetId));
for (const tid of tabs.keys()) {
  if (!liveTargetIds.has(tid)) {
    const tab = tabs.get(tid);
    if (tab) sessionIdToTargetId.delete(tab.sessionId);
    tabs.delete(tid);
  }
}
```

#### 2. Page cache pruning in listTabs (`src/client.ts`)
**File**: `src/client.ts`
**Changes**: Extend existing `listTabs` reconciliation to prune dead `pageCaches` entries.

```typescript
// listTabs — ADD page cache pruning after existing ownership reconciliation:
// After: const survivors = owned.filter((id) => live.has(id));
for (const tid of pageCaches.keys()) {
  if (!live.has(tid)) pageCaches.delete(tid);
}
```

#### 3. Multi-agent warning in system prompt (`src/prompt.ts`)
**File**: `src/prompt.ts`
**Changes**: Replace the "Parallel Execution" section (lines 63-73) with a version that adds the multi-agent note.

```typescript
// REPLACE the "Parallel Execution" section (lines 63-73):

### Parallel Execution

Observation tools (browser_screenshot, browser_page_info, browser_execute_js, browser_list_tabs, browser_http_get, etc.) can run in parallel with each other and with mutation tools. The harness automatically serializes mutation tools (click, type, scroll, navigate, switch_tab, etc.) so they never race on shared state. When operations are independent, emit them in the same turn for better performance.

**Examples of safe parallel calls:**
\`\`\`
browser_screenshot() + browser_page_info() + browser_execute_js("document.title")
browser_http_get("https://api.example.com/data") + browser_click(x, y)
\`\`\`

**Multi-agent note**: When multiple subagents use the browser, tab switching by one agent changes the active tab for all agents. Per-tab data (console buffers, network traces, dialogs, page info cache) is isolated — switching tabs does not destroy another agent's collected data. Call `browser_current_tab` before mutation tools to confirm you're on the expected tab. If `browser_page_info` returns a dialog, handle it with `browser_handle_dialog` promptly — dialogs block page interaction and are not queued across agents.
```

### Success Criteria:

#### Automated Verification:
- [x] Type checking passes: `npm run typecheck`
- [x] `grep "tabs.delete" src/cdp/session.ts` confirms cleanup logic
- [x] `grep "Multi-agent note" src/prompt.ts` confirms prompt update

#### Manual Verification:
- [ ] Close a tab manually in the browser — `browser_list_tabs` no longer shows it; its TabSession entry is cleaned up
- [ ] Restart the session — `attachFirstPage` reconciliation prunes dead TabSession entries from prior session
- [ ] Spawn two subagents. Subagent A's `browser_page_info` returns its own tab's data after Subagent B switches tabs. Both agents see the multi-agent warning in their system prompts.

---

## Testing Strategy

### Automated:
- `npm run typecheck` — all phases must pass type checking
- `scripts/test-parallel.ts` — mutex serialization + observation parallelization tests
- `scripts/test-parallel-integration.ts` — serialized mutation + observation + AbortSignal tests

### Manual Testing Steps:
1. **Tab switch buffer preservation**: Open tab A → navigate → `browser_console` → note `nextCursor` → switch to tab B → `browser_console` → switch back to A → `browser_console({ sinceSeq: cursor })` → ONLY tab A's new messages (no tab B contamination)
2. **Dialog isolation**: Tab A triggers alert → switch to tab B before calling `browser_page_info` → `browser_page_info` on tab B returns tab B's state (NOT tab A's dialog) → switch back to tab A → `browser_page_info` returns tab A's dialog
3. **Page cache isolation**: Tab A `browser_page_info` → tab B navigates (triggers dirty) → tab A `browser_page_info` again — must return stale cached tab A data (not re-fetched tab B data) IF tab A is still current. If tab B switched, tab A data comes from cache on switch-back.
4. **Target destruction**: Close a tab → its TabSession is removed → `browser_list_tabs` no longer shows it
5. **Session restart**: Kill and restart → dead tabs from prior session are pruned in reconciliation

## Performance Considerations

- `Map.get(targetId)` — O(1), negligible (single-digit entries typical)
- Each TabSession's buffers bounded at 500 records — no unbounded growth
- TabSession creation is lazy (on first visit to a tab via switchTo or attachFirstPage)
- No additional CDP round-trips — event routing is purely in-memory

## Migration Notes

Not applicable — no persisted schema changes. TabSession state is purely in-memory and reconstructed on each session start.

## References

- Design: `thoughts/shared/designs/2026-05-07_00-58_per-tab-isolation.md`
- Research: `thoughts/shared/research/2026-05-07_00-41_multi-agent-safety.md`
- Questions source: `thoughts/shared/questions/2026-05-07_00-26_multi-agent-safety.md`
