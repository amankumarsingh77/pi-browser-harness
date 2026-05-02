# Changelog

All notable changes to pi-browser-harness will be documented in this file.

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
