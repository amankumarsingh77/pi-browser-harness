---
date: 2026-05-07T00:58:00Z
designer: amankumarsingh77
git_commit: bd19739
branch: main
repository: pi-browser-harness
topic: "per-tab-isolation-multi-agent-safety"
tags: [design, session, isolation, per-tab, buffers, dialog, safety, concurrency]
status: complete
research_source: "thoughts/shared/research/2026-05-07_00-41_multi-agent-safety.md"
last_updated: 2026-05-07
last_updated_by: amankumarsingh77
---

# Design: Per-Tab Isolation for Multi-Agent Safety

## Summary

Add `TabSession` — a per-targetId state object in `session.ts` containing sessionId, targetId, dialog, pageInfoDirty, networkBuffer, and consoleBuffer — stored in a `Map<string, TabSession>`. The `consumeEvents` CDP event loop gains an `ev.sessionId` filter that routes events to the correct tab's buffer. `switchTo` preserves old tab state instead of clearing buffers. `client.ts` page cache becomes `Map<targetId, Cache>`. Delivered in two phases: Phase 1 (immediate `ev.sessionId` filter) and Phase 2 (full per-tab data structures). Phase 3 (agent-aware tab locking) is deferred.

## Requirements

- Tab switching must not clear another tab's network/console buffer data
- Dialog from tab A must not overwrite dialog from tab B
- Page info dirty flag must be per-tab, not global
- Console `sinceSeq` cursor must remain valid across tab switches (no cross-tab data leaks)
- Network buffer data must survive round-trip tab switches (A→B→A)
- Page info cache must be preserved per-tab across switches
- CDP events from unattached sessions must be filtered (no cross-contamination)
- Dead tab state must be pruned on target destruction and session reconciliation

## Current State Analysis

### Key Discoveries

- `src/cdp/session.ts:41-46` — Six mutable singletons: `sessionId`, `targetId`, `dialog`, `pageInfoDirty`, `networkBuffer`, `consoleBuffer`. All overwritten on `switchTo` (`session.ts:125-143`).
- `src/cdp/session.ts:136-137` — `networkBuffer.clear()` and `consoleBuffer.clear()` destroy all prior-tab data on every tab switch.
- `src/cdp/session.ts:33` — `consumeEvents` has no `ev.sessionId` filtering — events from all attached sessions route to the same singletons.
- `src/cdp/console-buffer.ts:256-262` — `clear()` preserves `nextSeq` (claiming safety), but this causes cross-tab data leaks for stale cursors. The fix: reset `nextSeq` on clear.
- `src/cdp/session.ts:150-151` — `callOnTarget()` escape hatch exists but is unused by observation tools — deferred to Phase 3.
- `src/client.ts:85` — Single `pageCache` nullified on any `switchTab` (`client.ts:183`).
- `src/cdp/ownership.ts:38-72` — OwnershipRegistry is the canonical pattern for per-target tracking: add/remove/has/list/replaceAll/onChange factory.

### Patterns to Follow

| New structure | Model after | File:Line |
|---|---|---|
| `TabSession` factory | `createOwnershipRegistry` | `ownership.ts:38-72` |
| `Map<string, TabSession>` | `ownership.ts:29` — `Set<string>` | `ownership.ts:29` |
| Per-tab page cache `Map<targetId, {info, at}>` | `client.ts:85,168-179` — single `pageCache` | `client.ts:85` |
| Buffer preservation on switch | `d3d86f9` — dialog preserved on close | `session.ts:78-83` |
| Dead TabSession pruning | `session.ts:112-118` — ownership reconciliation | `session.ts:112-118` |

## Scope

### Building
- Phase 1: `ev.sessionId` filter in `consumeEvents` — 1-line guard preventing cross-tab event contamination
- Phase 2: `TabSession` type + `Map<string, TabSession>` in `session.ts`
- Phase 2: Per-tab dialog (move `dialog` into TabSession)
- Phase 2: Per-tab `pageInfoDirty` (move flag into TabSession)
- Phase 2: Per-tab buffers (move `networkBuffer`/`consoleBuffer` into TabSession, preserve on switch)
- Phase 2: Per-tab page cache in `client.ts` (`Map<targetId, { info, at }>`)
- Phase 2: Console `nextSeq` reset on `clear()` in `console-buffer.ts`
- Phase 2: TabSession cleanup on `Target.targetDestroyed` and reconciliation
- Phase 2: Multi-agent warning in `prompt.ts` Parallel Execution section

### Not Building
- Agent-aware tab locking (requires pi platform agent identity exposure — Phase 3)
- Observation tool `callOnTarget` refactoring (Phase 3)
- Per-agent BrowserClient instances
- New CDP transport connections per agent

## Decisions

### TabSession model — one object per targetId
**Evidence**: `OwnershipRegistry` at `ownership.ts:29` uses a single `Set` with add/remove/has — one collection, not separate Maps per field. Grouping all per-tab state into one `TabSession` object per targetId follows this pattern and simplifies cleanup (one delete removes all state).
**Decision**: Single `TabSession` object per targetId stored in `Map<string, TabSession>`.

### ev.sessionId filter — immediate Phase 1
**Evidence**: Research Finding 9 identifies this as "the single most impactful change." Precedent-locator confirms it's the essential first move. One line in `consumeEvents` prevents dialog overwrites, dirty-flag theft, and buffer pollution.
**Decision**: Phase 1 delivers only this filter. Phase 2 builds per-tab structures on top.

### Buffers preserved, not cleared on switchTo
**Evidence**: `d3d86f9` established the pattern of NOT clearing dialog on transport close (`session.ts:78-83`) — data survives events that would otherwise destroy it. The same rationale applies to buffers on tab switch. Research confirms buffer clearing invalidates per-agent cursors.
**Decision**: `switchTo` no longer calls `networkBuffer.clear()` or `consoleBuffer.clear()`. Each tab's buffers persist in its TabSession.

### nextSeq reset on clear
**Evidence**: `console-buffer.ts:256-262` comment claims monotonic `nextSeq` prevents stale cursor matches — research Finding 4 proves the opposite. With per-tab buffers, each tab has independent seq space, eliminating the need for global monotonicity.
**Decision**: `clear()` resets `nextSeq` to 1.

### drain methods default to current tab — no API break
**Evidence**: Integration scanner confirms domain tools call `session.drainNetworkBuffer()`, `session.drainConsoleBuffer()`, `client.pageInfo()` which calls `session.takeDialog()` and `session.drainPageInfoInvalidations()`. All without parameters.
**Decision**: All drain/take methods accept optional `targetId` parameter defaulting to the current tab. Existing callers unchanged.

### pageCache stays in client.ts as Map
**Evidence**: `pageCache` at `client.ts:85` already has TTL, parse, and invalidation logic in `client.ts:168-179`. Moving it to session.ts would require exposing TTL constants and parse logic across module boundaries. Session-level dirty flag (TabSession.pageInfoDirty) is sufficient for invalidation.
**Decision**: pageCache in `client.ts` becomes `Map<targetId, { info: PageInfo; at: number }>`. TabSession carries the dirty flag.

## Architecture



### src/cdp/session.ts:1-194 — MODIFY

```typescript
// === Slice 1: Foundation ===
// All changes are within createCdpSession(). Existing singleton vars (dialog,
// pageInfoDirty, networkBuffer, consoleBuffer) remain for Slice 1 compatibility.

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

// consumeEvents — ADD filter guard as the FIRST statement inside the for-await loop:
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

### src/cdp/session.ts — Slice 2 additions (dialog + dirty flag into TabSession)

```typescript
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

// transport.onClose — dialog preservation moves to TabSession (no change needed;
// tabs.clear() already clears all TabSession state including dialog)
```

### src/cdp/console-buffer.ts:256-262 — MODIFY (Slice 3)

```typescript
// Replace the clear() method body — reset nextSeq to 1 on clear:
// OLD:
//   clear() {
//     records.clear();
//     overflowed = false;
//     // nextSeq is intentionally NOT reset: the cursor remains monotonic across
//     // tab switches so a stale sinceSeq from a previous tab can't accidentally
//     // match new records.
//   },
// NEW:
    clear() {
      records.clear();
      nextSeq = 1;
      overflowed = false;
    },
// Rationale: With per-tab buffers, each TabSession has its own console buffer
// with independent sequence space. Resetting nextSeq on clear prevents cross-tab
// data leaks — a stale cursor from tab X (seq 15) cannot match new records from
// tab Y (which restart at seq 1). The old monotonic-across-tabs behavior was a
// design inversion when buffers were shared.
```

### src/cdp/session.ts — Slice 3 additions (buffer routing + drain from TabSession)

```typescript
// consumeEvents — route network/console events to correct TabSession:
// Helper (inserted before the for-await loop):
const resolveTab = (evSessionId?: string): TabSession | undefined => {
  const tid = evSessionId ? sessionIdToTargetId.get(evSessionId) : targetId;
  return tid ? tabs.get(tid) : undefined;
};

// Replace all singleton buffer ingest calls with routed calls:
// OLD: if (ev.method === "Network.requestWillBeSent") networkBuffer.ingestRequestWillBeSent(ev.params);
// NEW:
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

### src/client.ts:85,157-180,183 — MODIFY (Slice 2)

```typescript
// REPLACE single pageCache with per-tab Map:
// OLD: let pageCache: { readonly info: PageInfo; readonly at: number } | null = null;
// NEW:
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

### src/cdp/session.ts — Slice 4 additions (TabSession cleanup)

```typescript
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
// (inserted after the ownership reconciliation block, after ownership.setHarnessWindow)
const liveTargetIds = new Set(allPages.map((p) => p.targetId));
for (const tid of tabs.keys()) {
  if (!liveTargetIds.has(tid)) {
    const tab = tabs.get(tid);
    if (tab) sessionIdToTargetId.delete(tab.sessionId);
    tabs.delete(tid);
  }
}

// listTabs in client.ts — ADD page cache pruning (extend existing reconciliation):
// After: const survivors = owned.filter((id) => live.has(id));
// Add:
for (const tid of pageCaches.keys()) {
  if (!live.has(tid)) pageCaches.delete(tid);
}
```

### src/prompt.ts:63-73 — MODIFY (Slice 4)

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

## Desired End State

```typescript
// Tab A and Tab B can coexist without cross-contamination:

// Agent on Tab A:
browser_navigate("https://site-a.com")       // navigates Tab A
browser_console({ sinceSeq: 0 })              // gets Tab A's console, nextCursor=5
// Agent switches to Tab B:
browser_switch_tab("targetId_B")
browser_navigate("https://site-b.com")       // navigates Tab B
browser_console({ sinceSeq: 0 })              // gets Tab B's console (separate buffer)
// Agent switches back to Tab A:
browser_switch_tab("targetId_A")
browser_console({ sinceSeq: 5 })              // continues from Tab A's cursor — data preserved!
browser_page_info()                           // returns Tab A's cached info (not stale from Tab B)

// Tab A's dialog doesn't leak to Tab B:
// Tab A triggers alert("A") → stored in TabSession["targetId_A"].dialog
// Tab B triggers confirm("B") → stored in TabSession["targetId_B"].dialog
// browser_page_info() on Tab B returns { dialog: { type: "confirm", message: "B" } }
// No overwrite. No silent loss.
```

## File Map

```
src/cdp/session.ts         # MODIFY — TabSession type, Map, ev.sessionId filter, switchTo rework, drain parameterization, cleanup
src/cdp/console-buffer.ts  # MODIFY — nextSeq reset on clear()
src/client.ts               # MODIFY — per-tab pageCache Map
src/prompt.ts               # MODIFY — multi-agent warning
```

## Ordering Constraints

- Slice 1 must come first (foundation — TabSession type, Map, ev.sessionId filter)
- Slice 2 depends on TabSession existing (dialog/dirty-flag/page-cache are TabSession fields)
- Slice 3 depends on TabSession existing (buffers are TabSession fields)
- Slice 4 depends on Slices 1-3 (cleanup reconciles against live TabSession entries)

## Verification Notes

From research Precedents & Lessons:
- **`d3d86f9`**: Event consumer must be serialized (already done). Surface crashes via console.warn (already done).
- **`71da8e0`**: Mutex serializes mutations globally, not per-tab. Per-tab data prevents corruption from this design limitation.
- **`20ceaa1`**: Ownership reconciliation pattern must be replicated for TabSession pruning.
- **`a1df2d3`**: Prefix matching hazard grows with owned tab count. TabSession Map uses full targetId keys — no prefix collision risk.

Verification checks:
- `tsc --noEmit` passes on modified files
- Two tabs: switch A→B→A, console cursor from A's first visit preserves state
- Dialog on tab A is NOT returned by takeDialog() after switching to tab B
- pageInfoDirty from tab B's navigation does NOT invalidate tab A's page cache
- Target.targetDestroyed event removes TabSession from Map
- attachFirstPage reconciliation prunes dead TabSession entries

## Performance Considerations

- `Map.get(targetId)` — O(1), negligible (single-digit entries typical)
- Each TabSession's buffers bounded at 500 records — no unbounded growth
- TabSession creation is lazy (on first visit to a tab via switchTo or attachFirstPage)
- No additional CDP round-trips — event routing is purely in-memory

## Migration Notes

Not applicable — no persisted schema changes. TabSession state is purely in-memory and reconstructed on each session start.

## Pattern References

- `src/cdp/ownership.ts:38-72` — OwnershipRegistry factory: add/remove/has/notify pattern
- `src/cdp/session.ts:41-46` — Current singleton state to extract into TabSession
- `src/cdp/session.ts:112-118` — attachFirstPage ownership reconciliation (replicate for TabSession)
- `src/client.ts:85,168-179` — pageCache TTL pattern (replicate as Map<targetId, Cache>)
- `src/cdp/network-buffer.ts:77-85` — Buffer factory + Map internal pattern

## Developer Context

**Q (`src/cdp/session.ts:41-46`, `src/client.ts:85`): Per-tab isolation scope chosen. Phase 1: ev.sessionId filter. Phase 2: per-tab data structures. Phase 3: agent-aware locking deferred.**
A: Approved — proceed with per-tab isolation design.

**Q (Decomposition): 4 slices: Foundation, Dialog+Dirty+Cache, Buffers+nextSeq, Cleanup+Prompt.**
A: Approved — proceed with slice-by-slice generation.

## Design History

- Slice 1: Foundation — approved as generated
- Slice 2: Dialog + dirty flag + page cache — approved as generated
- Slice 3: Buffer isolation + nextSeq fix — approved as generated
- Slice 4: Cleanup + reconciliation + prompt — approved as generated

## References

- Research: `thoughts/shared/research/2026-05-07_00-41_multi-agent-safety.md`
- Questions: `thoughts/shared/questions/2026-05-07_00-26_multi-agent-safety.md`
- Rewrite design: `docs/superpowers/specs/2026-05-02-harness-rewrite-design.md`
