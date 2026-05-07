---
date: 2026-05-07T00:41:00Z
researcher: amankumarsingh77
git_commit: bd19739
branch: main
repository: pi-browser-harness
topic: "Multi-agent safety: making browser tools safe for concurrent subagent usage"
tags: [research, mutex, ownership, dialog, tabs, session, concurrency, safety, subagents, isolation]
status: complete
questions_source: "thoughts/shared/questions/2026-05-07_00-26_multi-agent-safety.md"
last_updated: 2026-05-07
last_updated_by: amankumarsingh77
---

# Research: Multi-Agent Safety in pi-browser-harness

## Research Question

How can the browser harness be made safe for concurrent subagent usage? When multiple subagents are spun up, each using browser tools, they must not corrupt each other's state — tab switching, dialog handling, buffer reads, and page interactions must remain isolated.

## Summary

The harness was designed for single-agent use. All 6 safety-critical subsystems — the mutex, session, dialog buffer, page cache, network/console buffers, and ownership registry — are shared singletons with zero per-agent or per-tab partitioning. One agent switching tabs overwrites the global `sessionId`/`targetId`, clears all buffers, nullifies the page cache, and can silently consume or overwrite another agent's dialog. The approach: **phased per-tab isolation** — first an immediate `sessionId` filter on the CDP event consumer to stop cross-tab contamination, then per-tab data structures (dialog queues, page caches, buffer maps, dirty flags), and finally agent-aware tab locking to prevent one agent from switching away from another agent's active tab.

## Detailed Findings

### Finding 1: Mutation Mutex Serializes Globally, Not Per-Tab

The async FIFO mutex (`src/util/mutex.ts:12-23`) serializes the 22 mutation tools marked `serialized: true` in `src/registry.ts:25-49`. Observation tools (11 total, including `browser_execute_js`, `browser_screenshot`, `browser_page_info`, `browser_snapshot`) skip the mutex entirely.

**The mutex prevents concurrent mutation execution but does NOT provide per-agent isolation.** When Agent B calls `browser_switch_tab` (serialized, `src/domains/tabs.ts:93-128`), the global `sessionId`/`targetId` at `src/cdp/session.ts:41-42` is overwritten. Agent A's subsequent `browser_execute_js` (non-serialized observation, `src/domains/js.ts:55`) silently evaluates on the wrong tab's DOM — the mutex didn't block it because observation tools bypass the mutex. The `browser_execute_js` result contains no indication of which tab it ran on.

**The `callOnTarget` escape hatch exists but is unused** (`src/cdp/session.ts:150-151`). It accepts an explicit `sessionId`, which would allow per-agent session binding without switching the global session. No observation tool uses it — all call `session.call()` which binds to the global `sessionId` at `src/cdp/session.ts:148`.

### Finding 2: Shared SessionId/TargetId Is the #1 Corruption Vector

`src/cdp/session.ts:41-42` holds the single `sessionId`/`targetId` pair. The `switchTo()` method at `src/cdp/session.ts:125-143` performs a destructive overwrite:
- Activates the new target (line 128)
- Attaches a new CDP session (line 130)
- Overwrites `sessionId` and `targetId` (lines 133-134)
- Clears `networkBuffer` and `consoleBuffer` (lines 136-137)
- Sets `pageInfoDirty = true` (line 135)

`client.switchTab()` at `src/client.ts:179-190` compounds this by nullifying `pageCache` (line 183). There is no snapshot-and-restore mechanism, no per-agent tab stack, and no notification that the tab context changed.

**Concrete failure scenario**: Agent A is extracting data from tab X with `browser_execute_js`. Agent B calls `browser_switch_tab` to tab Y (serialized, so it waits its turn). After B's switch completes, A's next `browser_execute_js` runs on tab Y's DOM. If tab Y lacks the element A was querying, the result is `undefined` — a silent, undetectable corruption.

### Finding 3: Dialog Buffer Is a Single Slot With Silent Overwrite

`src/cdp/session.ts:43` stores one `dialog: DialogInfo | null`. Every `Page.javascriptDialogOpening` event from ANY attached session overwrites it at `src/cdp/session.ts:56-63` — there is no `ev.sessionId` filter, no queue, and no per-tab storage.

**Concrete failure scenario**: Agent A triggers `alert("Step 1")` on tab X. Before A consumes it via `browser_page_info`, Agent B triggers `confirm("Delete?")` on tab Y. The `dialog` variable is overwritten. When A calls `browser_page_info` (`src/client.ts:177-180`), `session.takeDialog()` returns B's confirm dialog. A dismisses it via `browser_handle_dialog` (`src/domains/dialog.ts:20`), which sends `Page.handleJavaScriptDialog` on the current session (now tab Y). Tab X's alert is never handled — its renderer remains blocked.

Additionally, `Page.javascriptDialogClosed` events are intentionally ignored at `src/cdp/session.ts:64-67`, meaning stale dialogs can persist indefinitely until `takeDialog()` is called.

### Finding 4: Network/Console Buffers Cleared on Tab Switch

Both buffers (`session.ts:46-47`) are cleared in `switchTo()` at `src/cdp/session.ts:136-137`. The console buffer's `nextSeq` counter (`src/cdp/console-buffer.ts:146`) is intentionally NOT reset on clear (lines 259-262), which causes a **cross-tab data leak for stale cursors**.

**The `nextSeq` claim is inverted**: The comment says "a stale sinceSeq from a previous tab can't accidentally match new records." In reality, because `nextSeq` is NOT reset, new records get seq numbers continuing from where the old tab left off. A stale `sinceSeq=15` will match new records with seq 16+ from the wrong tab. If `nextSeq` WERE reset to 1, stale `sinceSeq=15` would skip all new records (1 <= 15 is true).

**Concrete failure scenario**: Agent A iterates console output with `sinceSeq: 15` from a prior `nextCursor` on tab X. Agent B switches to tab Y, clearing the buffer. New tab Y logs appear with seq 16, 17. Agent A's next `browser_console({ sinceSeq: 15 })` returns tab Y's output — cross-tab data leakage. Agent A has no indication the data came from the wrong tab.

### Finding 5: Page Cache Invalidated Across Tabs

`src/client.ts:85` holds a single `pageCache` with 1-second TTL (`PAGE_INFO_TTL_MS = 1_000` at line 42). It's nullified on every `switchTab` (line 183) and on `Page.frameNavigated`/`Page.loadEventFired` events from ANY session (via shared `pageInfoDirty` flag at `src/cdp/session.ts:45`).

**While `switchTab → pageCache = null` is correct, Agent A still gets the wrong tab's info on the next `browser_page_info` call** because it reads from the globally-switched session. There is no per-agent "my current tab" context.

### Finding 6: Ownership Is Per-Session, Not Per-Agent

The `OwnershipRegistry` (`src/cdp/ownership.ts:26-72`) tracks which tabs belong to the harness session — it protects the USER's tabs, not sub-agent-to-sub-agent isolation. An agent can switch to any owned tab, including one another agent is actively using.

### Finding 7: Namespace Provides No Isolation

The extension's `client` variable at `src/index.ts:36` is a singleton. All agents share one `BrowserClient`. The `--browser-namespace` flag is cosmetic — used in error messages (`src/domains/tabs.ts:71-72`) and temp file paths (`src/util/paths.ts:13`), but provides zero multi-agent isolation within a single pi process.

### Finding 8: System Prompt Assumes Single-Agent Use

`src/prompt.ts:63-73` states that the harness "automatically serializes mutation tools so they never race on shared state" — this is intra-agent only. The prompt contains no warnings about:
- Tab switching invalidating buffers and cursors
- Dialog slot overwrites
- The need to verify `browser_current_tab` before mutations
- Other agents sharing the same browser

### Finding 9: Immediate Fix — `ev.sessionId` Filter

A single change in `consumeEvents` at `src/cdp/session.ts:33` would prevent ALL cross-tab event contamination:

```typescript
if (ev.sessionId && ev.sessionId !== sessionId && ev.method !== "Target.targetDestroyed") {
    continue;
}
```

This prevents dialog events from other tabs from overwriting the slot, navigation events from setting `pageInfoDirty` for the wrong tab, and network/console events from polluting buffers. It makes the single-slot design **correct for single-agent use** and eliminates the most egregious cross-tab contamination for multi-agent use.

## Code References

- `src/cdp/session.ts:41-42` — Singleton `sessionId`/`targetId` pair, overwritten on every tab switch
- `src/cdp/session.ts:43` — Single `dialog` slot, overwritten by any `Page.javascriptDialogOpening` without `sessionId` filtering
- `src/cdp/session.ts:125-143` — `switchTo()` destructively overwrites session state and clears buffers
- `src/cdp/session.ts:150-151` — `callOnTarget()` escape hatch exists but is unused by observation tools
- `src/cdp/session.ts:45` — Shared `pageInfoDirty` flag set by navigation events from any session
- `src/cdp/session.ts:136-137` — `networkBuffer.clear()` + `consoleBuffer.clear()` on every tab switch
- `src/cdp/console-buffer.ts:256-262` — `clear()` empties records but preserves `nextSeq`, enabling cross-tab data leaks
- `src/client.ts:85` — Single `pageCache` nullified on any `switchTab`
- `src/client.ts:89` — Single `mutationMutex` shared by all agents
- `src/util/tool.ts:127-138` — Serialized tool mutex acquisition with abort guard
- `src/util/mutex.ts:12-23` — 13-line async FIFO mutex with no per-agent awareness
- `src/registry.ts:25-49` — 22 serialized tools vs 11 observation tools
- `src/cdp/ownership.ts:26-72` — Flat ownership Set, no per-agent tab tracking
- `src/index.ts:36` — Singleton `client` variable — one per process, shared by all agents
- `src/domains/tabs.ts:88-118` — switchTabTool ownership enforcement (per-session, not per-agent)
- `src/domains/tabs.ts:167-188` — closeTabTool ownership enforcement
- `src/prompt.ts:63-73` — System prompt "Parallel Execution" assumes single-agent
- `src/state.ts:22-45` — State persistence with no namespace filtering in `restoreState`
- `src/domains/js.ts:55` — `browser_execute_js` uses implicit global `sessionId` via `session.call()`
- `src/domains/console.ts:122-151` — `sinceSeq` cursor pattern with no invalidation on buffer clear
- `src/domains/network.ts:119-154` — `browser_network_requests` body fetch races against tab switches

## Integration Points

### Inbound References
- `src/index.ts:99-119` — `session_start` creates the singleton `BrowserClient`, all agents share it
- `src/index.ts:152-161` — `before_agent_start` injects system prompt, fires for every agent turn with no per-agent customization
- `src/registry.ts:64-66` — `registerAllTools` binds all tools to the singleton `client` via closure

### Outbound Dependencies
- CDP WebSocket (`src/cdp/transport.ts:25`) — single connection to Chrome, all sessions multiplexed over it
- Chrome DevTools Protocol — `Target.attachToTarget`, `Target.activateTarget`, `Target.createTarget`, `Target.closeTarget`
- pi Extension API — `pi.registerTool`, `pi.on("before_agent_start")`, `pi.on("session_start")`, `pi.appendEntry`

### Infrastructure Wiring
- `src/cdp/transport.ts:68` — Single event queue consumed by exactly one `for await` loop in `session.ts`
- `src/cdp/session.ts:57-83` — Single `consumeEvents` loop routes CDP events to all buffers
- `src/client.ts:88-96` — `onOwnershipChange` → `persistState` → `pi.appendEntry` chain

## Architecture Insights

1. **The entire extension is designed around a single-agent-per-process model.** Every subsystem (transport, session, ownership, buffers, cache, mutex) assumes exclusive access. There is no concept of multiple independent consumers.

2. **The mutex provides execution serialization but not semantic isolation.** It guarantees two mutations don't run simultaneously, but cannot prevent Agent B from switching tabs between Agent A's observation and its next mutation.

3. **`callOnTarget` proves the transport layer supports per-target sessions.** The infrastructure is capable of per-agent isolation — the tool layer simply doesn't use it.

4. **The namespace system is identity-only, not isolation.** It's a label used in error messages and file paths. To become an isolation boundary, it would need to key into separate `BrowserClient` instances.

5. **Event filtering by `sessionId` is the single most impactful change.** It would fix dialog overwrites, dirty flag theft, buffer pollution, and stale event processing — all from one guard in `consumeEvents`.

6. **The console `nextSeq` non-reset is a design inversion.** The comment claims it prevents stale cursor matches — the exact opposite is true. Resetting `nextSeq` on clear would prevent cross-tab data leaks.

## Precedents & Lessons

4 similar past changes analyzed.

### Precedent: Parallel tool execution with automatic mutation serialization
**Commit(s)**: `71da8e0` — "feat: parallel tool execution with automatic mutation serialization" (2026-05-04)
**Blast radius**: 8 files across 5 layers
  - `src/util/mutex.ts` — new ~25 LOC async FIFO mutex
  - `src/util/tool.ts` — serialized lane acquisition + AbortSignal guard
  - `src/registry.ts` — 22 of 32 tools marked `serialized: true`
  - `src/client.ts` — `mutationMutex()` exposed on `BrowserClient`

**Follow-up fixes**:
- `f73941c` — Screenshot path rendering crash from parallel invocations

**Takeaway**: The mutex prevents mutation-on-mutation races but creates a global bottleneck — one sub-agent's slow `waitForLoad` blocks ALL other agents' mutations, even on different tabs.

### Precedent: Tab ownership — isolate harness tabs from user's browsing
**Commit(s)**: `20ceaa1` — "feat: tab ownership" (2026-05-05)
**Blast radius**: 8 files across 5 layers
  - `src/cdp/ownership.ts` — new 72-line OwnershipRegistry
  - `src/cdp/session.ts` — attachFirstPage reconciliation, targetDestroyed reaping
  - `src/domains/tabs.ts` — ownership gating on switch/close

**Takeaway**: Ownership protects the USER's tabs but does NOT protect sub-agents from each other. Two sub-agents share one `sessionId`/`targetId` — switching tabs is a global side effect.

### Precedent: CDP session with single-slot dialog buffer
**Commit(s)**: `d3d86f9` — "fix(cdp): serialize event consumer; persist dialog until taken" (2026-05-02)
**Blast radius**: `src/cdp/session.ts`

**Follow-up fixes**:
- `c9d1605` — Surface event-consumer crashes via `console.warn()`

**Takeaway**: The dialog's single-slot buffer was corrected for fast-dismiss races but remains unguarded against multi-session overwrites.

### Precedent: Audit fixes for list_tabs/switch_tab prefix matching
**Commit(s)**: `a1df2d3` — "release: v0.3.1 — audit fixes" (2026-05-02)
**Blast radius**: 9 files across 4 layers

**Takeaway**: Prefix resolution for targetIds becomes more ambiguous as owned-tab count increases in multi-agent scenarios.

### Composite Lessons
- ALL safety primitives are single-agent by design — `71da8e0`, `20ceaa1`, `d3d86f9`
- The mutex serializes globally, not per-tab — `71da8e0`
- Tab switching is a silent cross-agent side effect — `20ceaa1`
- Dialog buffer is a single slot with silent overwrite — `d3d86f9`
- Buffer clearing on tab switch invalidates per-agent cursors — `d3d86f9`
- Prompt and SKILL docs assume single-agent usage — `71da8e0`

## Historical Context (from thoughts/)
- `thoughts/shared/questions/2026-05-07_00-26_multi-agent-safety.md` — 10 trace-quality questions covering every safety subsystem
- `docs/superpowers/specs/2026-05-02-harness-rewrite-design.md` — v0.3.0 rewrite design; §2.2 enumerates 13 predictability bugs fixed by the module split
- `docs/RESEARCH.md` — Competitive analysis showing parallel execution + auto-serialization as a unique differentiator
- `CHANGELOG.md` — v0.3.2 documents parallel-safe boundary; v0.4.0 adds snapshot-first patterns

## Developer Context

**Q (`src/cdp/session.ts:41-46`): All safety primitives (mutex, ownership, session, buffers, dialog, page cache) are shared singletons with zero per-agent partitioning. Which isolation scope should we target?**
A: Per-tab isolation (Recommended) — Add per-tab data structures: per-tab dialog queue, per-tab page cache, per-tab buffer maps, per-tab dirty flags. Agents still share one client but each tab has independent state. Minimal change preventing data corruption without connection overhead.

**Q (`src/cdp/session.ts:33`): The per-tab isolation can be delivered in phases. Which delivery cadence?**
A: Quick-win first (Recommended) — Phase 1: `ev.sessionId` filter in `consumeEvents` (1-line fix). Phase 2: per-tab data structures. Phase 3: agent-aware tab locking.

## Related Research
- Questions source: `thoughts/shared/questions/2026-05-07_00-26_multi-agent-safety.md`

## Open Questions
1. **Agent identity exposure**: The pi platform currently does NOT expose the calling agent's ID to tool handlers. Phase 3 (agent-aware tab locking) requires identifying which agent initiated a tool call. Does the `ExtensionContext` carry agent identity, or would this require a pi platform change?
2. **Observation tool isolation**: Even after per-tab data structures, observation tools (`browser_execute_js`, `browser_screenshot`) will still read from the globally-switched session. Should they be changed to use `callOnTarget` with a per-agent cached sessionId?
3. **Tab switching protocol**: Should agents be required to explicitly "check out" and "release" tabs? Or should the harness auto-detect which agent was last on a tab and restore context before executing tools?
4. **Namespace-per-client in separate processes**: When two separate pi processes (e.g., parent + subagent) both load the harness, each creates its own `BrowserClient` — they're naturally isolated. Should we document this pattern as the recommended multi-agent approach?
