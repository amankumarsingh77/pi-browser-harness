# Changelog

All notable changes to pi-browser-harness will be documented in this file.

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
