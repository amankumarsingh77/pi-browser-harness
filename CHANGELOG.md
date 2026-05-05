# Changelog

All notable changes to pi-browser-harness will be documented in this file.

## 0.4.0 — 2026-05-06

### Added

- **`browser_snapshot`** — new tool. Returns the structured CDP accessibility tree (roles, names, states, hierarchy) for the current page. For every interactive element (button, link, textbox, checkbox, etc.) the outline includes click coordinates as `@(x,y)`, fetched via `DOM.getBoxModel` per node in parallel under a 1.5s aggregate budget. Pass these straight to `browser_click` — no `browser_screenshot` round-trip needed. `format:"json"` returns the slim structure with `box: {x,y,width,height,cx,cy}` per node. Optional `includeScreenshot:true` attaches a JPEG (q=80) when visual confirmation is also wanted.
- **`browser_network_requests`** — new tool, replacing the deprecated `browser_get_network_log` placeholder. Lists requests captured on the current tab since attach with filters: `urlPattern` (substring; wrap in slashes for regex), `methodFilter`, `statusFilter`, `resourceTypes`, `sinceMs`, `limit` (default 50, cap 500). `includeResponseBodies:true` fetches `Network.getResponseBody` per matched record under a 5s aggregate budget with a 50 KB per-body cap. Buffer is page-scoped (cleared on tab switch) and bounded at 500 records; `bufferOverflowed` flag in the result reports drops since the last drain.
- **Tab ownership / harness-window isolation.** New `OwnershipRegistry` tracks which page targets this session opened. The harness now creates a dedicated Chrome window on first attach (`newWindow:true`) instead of grabbing the user's foreground tab; subsequent `browser_new_tab` calls open inside that window via `openerId`. `browser_list_tabs` defaults to `scope:"owned"`; pass `scope:"all"` to see the user's other tabs read-only. `browser_switch_tab` and the new **`browser_close_tab`** refuse non-owned tabs with a clear remediation hint. Ownership is persisted across session reloads via `BrowserState`. The session also subscribes `Target.setDiscoverTargets` and reaps `targetDestroyed` events so the registry stays in sync.
- **`Accessibility` CDP domain enabled** alongside Page/DOM/Runtime/Network on every attach.
- **`Ctrl+O` (`app.tools.expand`) expand/collapse on tool output.** Three tools now ship custom `renderResult`:
  - `browser_snapshot` — collapsed: 4-line summary (node count, URL, landmarks/buttons/inputs, screenshot status). Expanded: full indented outline + inline screenshot when `includeScreenshot:true`.
  - `browser_network_requests` — collapsed: header + first 5 rows. Expanded: full markdown table + per-request body sections when bodies were requested.
  - `browser_execute_js` — collapsed: size + first 120-char preview. Expanded: pretty-printed JSON if value parses, otherwise raw value, in a code fence.
  All three append a `keyHint("app.tools.expand", ...)` so the binding label adapts to user remaps.

### Changed

- **Tool prompts pivoted from screenshot-first to snapshot-first.** `browser_screenshot`'s description now explicitly says "NOT a default exploration tool". `browser_snapshot` is documented as the default for understanding pages; `browser_execute_js` as the default for surgical reads. `browser_click` guidance no longer instructs the agent to screenshot for coordinates — it points at `browser_snapshot`'s `@(x,y)` hints. `browser_open_urls` post-step flipped from screenshot to snapshot.
- **`SKILL.md` rewritten** (~342 lines → ~53 lines). Frontmatter description carries the tool-hierarchy hint (always in context per pi's progressive-disclosure model). Body keeps only what isn't already in tool prompts: the decision tree, the connection rules (real Chrome, no creds, dialog-first), and the `browser_run_script` daemon bindings (the only tool whose API can't be inferred from its prompt). Pattern reference, parallelization details, troubleshooting, and tool enumeration removed as duplication.
- **CDP `Network.*` events** are now consumed by an in-process aggregator (`src/cdp/network-buffer.ts`) wired into the existing single-consumer event loop in `src/cdp/session.ts`. Pure module, ring-buffered, non-destructive drain.

### Removed

- **`browser_get_network_log`** — was a deprecated placeholder in v0.3 that returned a "use PerformanceObserver" message because the CDP event stream had no public drain API. Replaced by `browser_network_requests`.

### Known follow-ups

- Live network streaming (`browser_network_monitor` real-time during a click) — deferred; reuses the same buffer plumbing once the post-hoc form is proven.
- No tests added in this release. Verification is manual against real Chrome.

## 0.3.2 — 2026-05-05

### Added

- **Parallel tool execution with automatic mutation serialization.** Observation tools (`browser_screenshot`, `browser_page_info`, `browser_execute_js`, `browser_list_tabs`, `browser_http_get` etc.) can now run in parallel with each other and with mutation tools. Mutation tools (`browser_click`, `browser_type`, `browser_scroll`, `browser_navigate`, `browser_switch_tab`, etc.) are automatically serialized through a shared async mutex so they never race on shared CDP session/page state. LLMs can emit independent operations in the same turn for better latency.
- **New `src/util/mutex.ts`** — lightweight async mutex (~25 LOC) with FIFO queue. `serialized?: boolean` flag added to `BrowserToolDefinition`; `mutationMutex()` exposed on `BrowserClient`.
- **Prompt and SKILL.md** updated with parallel-execution guidance and safe-parallel-call examples.

### Fixed

- **Scroll tool deltaY sign convention corrected.** Previously `deltaY` was documented as positive=up (inverted vs W3C wheel events). Now follows the W3C convention: positive=down, negative=up. Default changed from `-300` to `300` (scroll down). Prompt snippets, tool descriptions, and guidelines all updated.
- **Scroll tool now calls `Page.bringToFront`** before dispatching mouse events, preventing silent-drop when the target page is not the active browser tab. Mouse events now include explicit `button:"none"`, `buttons:0`, `pointerType:"mouse"`.
- **Screenshot TUI render no longer crashes the host on long file paths.** The `Image` text-fallback render did not respect terminal width, so a long path could overflow and crash the host TUI. Each rendered line is now truncated with `truncateToWidth` to fit the available width.

## 0.3.1 — 2026-05-02

### Bug fixes

- **`browser_list_tabs`** now shows full 32-character targetIds instead of truncated `BE9DD1DC…` prefixes. The `browser_list_tabs` → `browser_switch_tab` round-trip is repaired.
- **`browser_switch_tab`** now supports prefix matching: pass a unique hex prefix (≥8 chars) and it resolves to the full targetId automatically. Ambiguous prefixes return a clear error listing all matching tabs.
- **`browser_download`** auto-creates the download directory with `mkdir -p` if it doesn't exist. Previously it required a pre-existing writable directory.
- **`ensureAlive()`** now probes the page session with `Runtime.evaluate("1")` after the transport health check. If the page target has crashed (e.g. localhost server died), it reattaches automatically instead of returning a cryptic `session_not_found` error on the next tool call.

### Docs & metadata

- **`browser_dispatch_key`** prompt guidelines now explicitly note it dispatches a synthetic DOM `KeyboardEvent` and does NOT type text. Point users to `browser_type` / `browser_press_key` for actual text input.
- **`browser_navigate`** prompt guidelines now warn that Google and strict-anti-bot sites may reject CDP navigation. `browser_http_get` is the recommended workaround.
- **`browser_get_network_log`** prompt snippet updated with explicit workaround (`browser_execute_js` with `PerformanceObserver`).
- **`sharp`** added to `optionalDependencies` so `npm install` attempts it (enables `browser_screenshot` `maxDim` auto-resize).
- **`SKILL.md`** script bindings section updated to document the actual daemon API: `daemon.evaluateJs()`, `daemon.pageInfo()`, `daemon.listTabs()`, `daemon.session().call()`. Example script updated to match.
- **`SKILL.md`** troubleshooting section now covers `sharp`/`maxDim` and Google anti-bot navigation.

## 0.3.0 — 2026-05-02

### Internal rewrite

- Per-domain module split: every tool now lives in its own `src/domains/<name>.ts` file. The 1140-line `daemon.ts` and 2277-line `tools.ts` are gone; the three largest files are now `src/cdp/transport.ts` (~220 LOC), `src/client.ts` (~220 LOC), and `src/domains/js.ts` (~200 LOC).
- New transport/session/client split: `BrowserDaemon` class replaced with `createBrowserClient()` factory composing a `CdpTransport` (factory) and `CdpSession` (factory).
- All tool handlers now return `Result<T, E>`; one `defineBrowserTool` helper converts to pi's `ToolDefinition` and supplies a uniform `details` shape: `{ ok: true, ... }` on success, `{ ok: false, kind, message, ... }` on error.
- Strict TypeScript flags enabled (`noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `noPropertyAccessFromIndexSignature`, `noUnusedLocals`, `noUnusedParameters`). Zero `any` in the codebase. All boundary `as` casts documented.

### Bug fixes (predictability)

- `browser_navigate` no longer silently creates a new tab when navigation fails; outcome is reported explicitly via `details.outcome.kind` (`"in_place"` | `"new_tab_created"`).
- Page-info cache invalidation is now automatic: the session subscribes to CDP `Page.frameNavigated` / `Page.loadEventFired` events. The 5 manual `invalidatePageInfoCache()` calls are gone.
- Dialog read no longer mutates state on `Page.javascriptDialogClosed` — the dialog persists in the buffer until `takeDialog()` is called, fixing a fast-dismiss race that dropped dialogs.
- `browser_dispatch_key` now returns `details.matched` (count of elements the synthetic event was dispatched to). Zero matches is an `invalid_state` error instead of a false success.
- `browser_http_get` timeout now covers the response body read (legacy aborted headers but `await response.text()` could hang indefinitely).
- `sharp` failures are distinguished from "sharp not installed" — actual errors no longer masked by the install hint.
- Screenshot paths use `randomUUID()` per-namespace — no more concurrent-write collisions from `Date.now() + global counter`.
- Reconnect is lazy (via `ensureAlive`) — no background reconnect, no stacked Chrome consent popups.
- WebSocket events are routed through an `AsyncIterable` bound to each connection — stale events from a previous connection can no longer leak across reconnects.
- `browser_wait_for_load` returns a typed `timeout` error if the deadline elapses (legacy returned a soft string).

### Security fixes

- All JS evaluation source is built via `safeJs\`...\`` (always JSON.stringify-safe). The previous `replace(/'/g, "\\'")` selector escaping (broken for backslashes, newlines, unicode quotes, `</script>`) is gone.
- `browser_run_script` now requires:
  - script path inside `tmpdir()`, `cwd()`, or `BH_SCRIPT_DIR` (other paths rejected with `invalid_state`)
  - a mandatory timeout (default 60s, max 600s, enforced via `Promise.race`)
  - the AbortSignal is honored even if the script ignores its `signal` parameter
  - source size ≤ 1 MB
  - return shape validated structurally (each content item must be `{ type: "text", text: string }`)
- `browser_download` validates the directory exists and is writable before calling CDP (Chrome was silently downloading to nowhere if the dir was bogus).
- `browser_upload_file` verifies the file exists and is readable before any CDP call (prevents half-set state on the input).
- `pdfPath()` / `screenshotPath()` validate the namespace against a strict regex so a hostile namespace cannot escape `tmpdir()`.

### Parameter renames (saved scripts must be updated)

- `browser_click`: `clicks` → `count`
- `browser_dispatch_key`: `event` → `eventType`

### Removed

- The unused `tabHistory`, `screenshotDir`, and `debugClicks` fields on persisted state.
- The dead `tool_result` hook in `index.ts` for tab-history tracking (`details.targetId` was never set by any tool).
- `src/protocol.ts`, `src/renderers.ts`, `src/daemon.ts`, `src/tools.ts` (replaced by per-domain files and `client.ts`).

### Known follow-ups

- `browser_get_network_log` returns a structured deprecation note. The new transport routes events through an `AsyncIterable` consumed by the session manager; a synchronous `recentEvents()` API is deferred. Use `browser_execute_js` with `PerformanceObserver` or `performance.getEntries()` as a workaround.
- `browser_run_script` script binding is named `daemon` for back-compat, but the underlying object is now a `BrowserClient`. Scripts using `daemon.cdp(method, params)` should switch to `daemon.session().call(method, params)`.
- No tests added in this rewrite; that's a separate workstream.

## [0.2.0] - 2026-05-02

### Changed
- **Performance: fast `ensureAlive()`** — skips CDP `Target.getTargets` health-check roundtrip on every tool call. Uses WebSocket state check + 30s TTL. 96% faster per-call setup.
- **Performance: event-based `waitForLoad()`** — replaces `readyState` polling (300ms interval) with CDP `Page.loadEventFired` / `frameStoppedLoading` event draining (50ms interval). Detects already-loaded pages in ~1ms (99.5% faster).
- **Performance: JPEG screenshot support** — `captureScreenshot()` accepts `format` (png/jpeg) and `quality` (1-100). JPEG q80 is 29-49% smaller than PNG for complex pages, speeding up CDP transfer and reducing LLM context cost.
- **Performance: page info caching** — `getPageInfo()` caches results for 1 second, eliminating redundant `evaluateJS` CDP roundtrips on back-to-back calls.
- **Performance: parallel domain enables** — `switchTab()` enables Page/DOM/Runtime/Network domains via `Promise.all` instead of sequential await.
- **Tools: `browser_screenshot`** now accepts `format` (png/jpeg) and `quality` parameters.
- **Tools: `browser_wait_for_load`** now uses `daemon.waitForLoad()` (event-based) instead of polling.

## [0.1.0] - 2026-05-02

### Added
- Initial release of pi-browser-harness.
- 20 browser control tools (`browser_navigate`, `browser_screenshot`, `browser_click`, `browser_type`, `browser_press_key`, `browser_scroll`, `browser_execute_js`, `browser_http_get`, `browser_new_tab`, `browser_open_urls`, `browser_switch_tab`, `browser_list_tabs`, `browser_current_tab`, `browser_page_info`, `browser_go_back`, `browser_go_forward`, `browser_reload`, `browser_wait`, `browser_wait_for_load`, `browser_handle_dialog`).
- Self-extending harness: `list_dynamic_tools`, `register_tool`, `remove_tool` — the agent can write new browser tools at runtime.
- Guided setup command (`/browser-setup`) with Chrome detection, automatic browser-harness installation via `uv` or `git clone`.
- `/browser-status` and `/browser-reload-daemon` commands for daemon health monitoring.
- `--browser-namespace` and `--browser-debug-clicks` CLI flags.
- Session persistence for tab history and daemon namespace across reloads and branch navigation.
- System prompt injection with browser usage guidance and common workflow patterns.
- Custom TUI renderers for screenshots and tab listings.
- Dialog detection and handling for JS `alert`/`confirm`/`prompt`/`beforeunload`.
- Parallel URL opening via `browser_open_urls` with live progress streaming.
- Output truncation with temp-file fallback for large JS evaluation and HTTP responses.
