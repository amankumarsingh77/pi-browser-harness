# Changelog

All notable changes to pi-browser-harness will be documented in this file.

## 0.11.1 — 2026-08-12

### Fixed

- **Chrome remote-debugging consent is no longer retriggered indefinitely in the background.** A cancelled, failed, or disconnected CDP connection now remains disconnected until the next explicit browser request, which makes one on-demand connection attempt instead of running an unbounded retry loop that can repeatedly interrupt normal browsing.
- **`browser_run_script` accepts paths on Windows again.** The allowed-directory check compared against a hardcoded `/` separator, so every backslash path — including files inside `os.tmpdir()`, which the rejection message itself listed as allowed — was refused. Containment is now decided by `path.relative`, which carries each platform's own separator and case rules.
- **The daemon starts from a production install.** `tsx` is needed to run the daemon but was declared only as a dev dependency, so `browser_setup` reported `Could not start the browser daemon` under `npm omit=dev`. It is now a runtime dependency, and the daemon is launched via the CLI entry that Node's resolver finds — a fixed `node_modules/.bin` path does not exist in a hoisted install, which is how pi lays extensions out.

## 0.11.0 — 2026-08-02

### Fixed

- **`--browser-debug-clicks` now does something.** The flag was registered and documented but never read; the only working switch was the undocumented `BH_DEBUG_CLICKS` environment variable. Both now drive the same setting.
- **`BU_CDP_WS` now actually attaches to a remote browser.** The client read the variable and passed the URL to `transport.connect()`, but the daemon transport discards that argument and always dials the daemon socket — and the daemon's own discovery never looked at the variable, so setting it changed nothing. The override moved into `discoverEndpoint`, which both processes go through. It is read when the daemon starts, so a running daemon must be stopped first.
- **A disconnected client's pending requests no longer fire at a dead socket.** `removeClient` cleared the daemon's id multiplexer but not its callback map, so a gone client's command timeouts stayed armed and later tried to answer it.

### Changed

- **One route from a tool to the browser.** Four coexisted; `src/domains/cdp-call.ts` is now the only one, and two boundary-scanner rules scoped to `src/domains/` keep it that way. A CDP timeout now surfaces as `kind: "timeout"` instead of `cdp_error` at the sites that previously flattened it.
- **Shared logic moved out of tool files** into `ax-tree.ts`, `element-call.ts`, and `screenshot-capture.ts`, so importing one tool no longer pulls in another tool's module. `cdp/attach.ts` and `cdp/window.ts` became `session.attach()` and `session.windowId()`; `cdp/daemon-transport.ts` became `daemon/transport.ts`; the request-timeout half of `cdp/event-queue.ts` became `cdp/pending-requests.ts`.
- **The daemon's request bookkeeping is one map instead of two**, and a request that arrives while Chrome is down awaits a single connect signal rather than spinning its own 250 ms poll loop.

### Removed

- **The second CDP transport.** `createCdpTransport` was a full WebSocket-to-Chrome implementation reachable only through a fallback in `client.ts` that production never took. `cdp/transport.ts` now holds just the `CdpTransport` interface, and a client must be given a transport.
- **Dead exports and a fake config knob:** `isInternalUrl`, `SPECIAL_KEYS`, `andThen`, `mapErr`, `BrowserState.remoteBrowserId`, `IpcServer.disconnectClient`, `IpcServer.clients()`, and `DAEMON_STALE_SOCKET_CLEANUP` (a hardcoded `true` with a branch around it).

- **The `deep-research` skill, the `/deep-research` command, and the `web-search-researcher` subagent.** The harness ships browser tools; orchestrating multi-agent research on top of them belongs to the agent, not to this extension. `browser_web_search` and `browser_read_page` are unaffected — search then read still works, it is just no longer wrapped in a fan-out workflow.

## 0.10.3 — 2026-07-26

### Fixed

- **Profile binding after an in-place browser upgrade.** Linux appends `" (deleted)"` to `/proc/<pid>/exe` once the running binary is unlinked — which is exactly what a `google-chrome` package update does while the browser stays open. `detectRunningBrowser` returned that literal string as the executable path, so every profile launch tried to spawn `/opt/google/chrome/chrome (deleted)` and failed with `ENOENT`. Executable paths are now validated against disk, with the marker stripped (and argv[0] used) when the linked binary is gone.
- **A failed browser launch no longer reports as a sentinel timeout.** `spawn()` signals a missing or non-executable binary asynchronously via an `error` event rather than by throwing, and that event was discarded — so `openProfileWindow` returned success, no window ever opened, and the caller blamed the browser 15 seconds later with `couldn't open a window in "<profile>" automatically`. The launch now waits for `spawn`/`error` and returns the real cause, and removes its handshake page on the failure path.

## 0.10.2 — 2026-07-26

### Fixed

- **Page info no longer fails on a missing `documentElement`.** The page-info probe read `document.documentElement.scrollWidth`/`scrollHeight` directly, which throws when `documentElement` is absent — leaving every caller with an evaluation error instead of a page snapshot. The probe now falls back to zeroed scroll dimensions and returns a usable `PageInfo`.

## 0.10.1 — 2026-07-26

### Fixed

- **Chrome process leak on profile seed failure.** When a profile is pinned and `seedProfileWindow` spawns Chrome via `openProfileWindow`, the spawned child is kept as `detached: true` + `unref()`. If Chromium's ProcessSingleton fails to delegate (user-data-dir mismatch, multiple browsers, Chrome busy/crashed), the spawned process starts a full second browser instance. The sentinel never appears, the seed times out, but the spawned Chrome process was never killed — accumulating zombie browser instances that consume RAM. The fix stores the child process reference, exposes a `kill()` on the returned handle, and calls it on seed timeout.
- **Unnecessary Chrome re-spawns on every `start()`.** `profileContextId` was unconditionally cleared on every `start()`, forcing a new profile-window launch via ProcessSingleton even when Chrome hadn't restarted and the context was still valid. Now the context is cleared only when the browser UUID in the WebSocket URL changes — which Chrome re-mints on every launch.
- **`setProfilePin` no longer clears context when the pin hasn't changed.** Loading the same pin from disk on `session_start` was clearing `profileContextId`, forcing yet another Chrome spawn on the next `start()`.

## 0.10.0 — 2026-07-25

### Added

- **`/browser-profile` — choose which browser profile the agent works in.** The command lists every profile in the connected browser, labelled `Name (email)` (or `Name (Profile 3)` when the profile has no signed-in account), marks the current selection, ordered the way the browser orders them. The choice is saved to `~/.pi/agent/browser-harness.json`, so it survives session termination, pi restarts, and applies across projects; a trailing `— Clear selection —` row restores the previous behavior. Picking a profile mid-session takes effect immediately — the harness closes its tabs and reopens its window in the chosen profile.
- **First-run profile prompt.** When no profile has been chosen, `/browser-setup` and the agent-callable `browser_setup` show the same picker before connecting, and report the result as `Browser profile: <label>`. With no interactive UI (print/RPC mode) or when the user cancels, setup continues with a one-line note and the pre-existing behavior, so non-interactive usage is unaffected.
- **`/browser-status` reports the selected profile.**

### Fixed

- **The agent no longer lands in an arbitrary browser profile.** Harness tabs were created with a bare `Target.createTarget`, which places them in Chrome's `defaultBrowserContextId` — a value that follows window focus. The profile the agent acted as therefore depended on which browser window the user last clicked, so the same task could run as a work account on one run and a personal account on the next. With a profile pinned, the harness opens its window inside that profile and keeps every tab there. Chrome offers no direct route for this: `Target.createTarget` rejects another profile's `browserContextId` outright, and `openerId` does not inherit the opener's context. The window is opened through the browser's own command line (`--profile-directory`, which Chromium's ProcessSingleton hands to the already-running browser) and identified by a unique `file://` sentinel page; subsequent tabs come from `window.open` evaluated with `userGesture: true`, which is the only CDP-reachable way to place a tab in a non-default browser context. When the window cannot be opened, the harness reports it and stops rather than silently using another profile.
- **Tab creation is funnelled through one place** (`src/cdp/target-factory.ts`). `browser_open_urls` and the isolated tabs behind `browser_web_search` / `browser_read_page` previously called `Target.createTarget` themselves, so under a pinned profile they would have run with a different profile's cookies than the visible tabs.
- **Snap-installed Chromium is discovered.** Ubuntu's default Chromium keeps its user data in `~/snap/chromium/common/chromium`, which was absent from the discovery list, making it invisible to the harness.
- **Windows profile discovery honours `%LOCALAPPDATA%`** instead of assuming `AppData\Local` under the home directory — the two diverge on roaming and managed accounts. Browsers launched with an explicit `--user-data-dir` (and Linux's `$CHROME_USER_DATA_DIR`) are now found as well.
- **The right browser is identified when several are running.** Browser detection now ranks candidate processes against the user-data-dir the harness is actually connected to, instead of taking the first Chromium-family process it finds; with Chrome and Brave both open, a profile window could otherwise be opened in a browser the harness is not attached to. Detection also reports the executable path and any explicit `--user-data-dir`, and on Windows uses PowerShell CIM plus the App Paths registry key rather than `wmic`, which Microsoft removed by default in Windows 11 24H2.
- **Installed-but-closed browsers are no longer mistaken for running ones** — liveness is derived only from live-process evidence.

### Tests

- Fixture-driven unit suites for profile enumeration, pin persistence, per-OS path resolution, and browser-process ranking (`test/profile/`), plus a real-browser end-to-end test (`test/manual/profile-e2e-test.ts`) that creates two profiles in a throwaway user-data-dir and asserts distinct browser contexts, sentinel-based window identification, and that spawned tabs stay in the pinned profile and window.
- CI now runs the profile suites and the end-to-end test on **ubuntu, macOS, and Windows** (Linux under Xvfb). Profile discovery is the one part of the harness whose behavior genuinely differs per OS, and the runner images ship real Chrome, so the cross-platform launch handshake is verified rather than assumed.

## 0.9.0 — 2026-07-24

### Added

- **`browser_web_search`** — new tool. Query → ranked links by scraping a real Google SERP in the user's own Chrome, so no API key or search subscription is involved. Runs in an isolated tab whose lifecycle mirrors `browser_open_urls` (never touches the user's current tab). The SERP parser is pure and fixture-tested (9 scenarios), extracts results semantically (`a h3`) and unwraps redirect URLs. CAPTCHA walls and empty result sets surface as `invalid_state` with `details.reason` rather than an empty list.
- **`browser_read_page`** — new tool. URL (or an owned `targetId`) → clean main-article text with nav/ad/footer boilerplate stripped, via a dependency-free readability heuristic. The DOM walk runs as an in-page capture expression; scoring and selection are a pure, fixture-tested function (link-density plus boilerplate-ancestor filtering, with a body-text fallback for pages that have no article structure). Registered unserialized, so concurrent reads are safe.
- **`deep-research` skill and `/deep-research` command.** Fans out to isolated `web-search-researcher` subagents, runs a coverage-driven loop with a hard iteration ceiling, and synthesizes a cited Markdown report. The researcher agent now uses `browser_web_search` + `browser_read_page`; it previously referenced `web_search`/`web_fetch` tools that do not exist in this harness.
- **Forms domain with a universal field setter.** `browser_fill`, `browser_fill_form`, `browser_select_option`, and `browser_set_checked` now live in `src/domains/forms.ts` behind one setter that auto-detects the element type and fires framework-compatible input events (the React native-setter trick), so controlled inputs register the change instead of silently reverting.
- **Durable window binding.** Every new-window code path now captures the real Chrome `windowId` and binds it as the session's window identity, so per-session tab ownership survives navigation and tab churn instead of being inferred fresh each time.
- **Brave support and additional Chrome channels.** `checkChromeRunning()` recognizes Brave (macOS `brave browser`, Linux `brave`/`brave-browser`, Windows `brave.exe`) alongside Chrome/Chromium/Edge, and now excludes `gpu`/`updater` sub-processes that linger after a browser quits. Profile discovery covers Brave Stable/Beta/Nightly/Dev and Chrome Beta/Dev/Canary/Chromium across macOS, Linux, and Windows.
- **Expand/collapse (Ctrl+O) rendering for `browser_web_search` and `browser_read_page`,** via a shared `renderExpandableText` helper (`src/domains/render.ts`) mirroring `browser_execute_js`. Compact preview by default, full body on expand; the complete text still reaches the model regardless of render state. The `web_search` summary line surfaces engine and result count.

### Fixed

- **Daemon setup now works on Windows.** The Unix-socket daemon introduced in 0.6.0 carried several POSIX-only assumptions that broke setup entirely on Windows: `DAEMON_SOCKET_PATH` is now a named pipe (`\\.\pipe\pi-browser-daemon`) on win32, since a `/tmp` path is not a valid `net` listen/connect target there; `spawnDaemon()` resolves `tsx.cmd`/`npx.cmd` and runs them through a shell with per-token quoting (paths with spaces) and `windowsVerbatimArguments`, because npm's `.cmd` shims fail with EINVAL/ENOENT when spawned directly; `isDaemonRunning()` skips the `fs.access` pre-check and probes the pipe directly, as named pipes are not filesystem entries and `access()` always fails on them; and stale-socket `unlink()` is a no-op on Windows, where pipes self-clean. (#7)
- **Stale `DevToolsActivePort` files no longer break CDP discovery.** Discovery previously trusted the first readable port file — a browser that has quit leaves its file behind, so when another browser later bound the same port (e.g. 9222), discovery returned a WS URL carrying the dead browser's UUID against the live browser's server and the connection failed. `discoverWsUrl()` now collects all readable candidates, keeps the most recently written file when candidates share a port, skips ports that aren't live via a fast single-shot probe (no 30s `waitForPort` block on stale files), and asks each live browser for its canonical `webSocketDebuggerUrl` via `/json/version`, falling back to the file's WS path when that endpoint is disabled. Well-known ports (9222, plus `BU_CDP_PORTS`) are probed both when no profile file is readable — covering sandboxed harnesses hitting EPERM/EACCES and non-default install locations — and after all discovered candidates prove stale. Ports parsed from a truncated or corrupt file are validated before use, since `net.connect` throws `ERR_SOCKET_BAD_PORT` synchronously for `NaN`/out-of-range values, which previously escaped as an unhandled rejection. (#4)
- **Footer browser status indicator removed.** The chip set during `session_start` went stale: a successful `/browser-setup` only called `ctx.ui.notify()` and never updated `ctx.ui.setStatus("browser", …)`, so the red "Browser — run /browser-setup" nudge persisted while the browser was in fact connected. Browser control is on-demand and setup already reports its own outcome, so the persistent chip was removed rather than resynced. (#10)

### Changed

- **Setup guidance** now mentions `brave://inspect` / `edge://inspect` and the `--remote-debugging-port` launch flag.

## 0.8.3 — 2026-07-08

### Fixed

- **Stale socket detection no longer blocks daemon spawn after a crash.** `isDaemonRunning()` only checked that the Unix socket file existed; a dead daemon leaves a stale socket behind, so `ensureDaemon()` skipped spawning and `client.start()` failed with "Chrome not connected". It now runs a liveness probe — connect, register, verify the ack, disconnect — and cleans up the stale socket on failure. The bridge's `handleRequest` is also async, polling for a Chrome connection for up to 15s before rejecting.

## 0.8.1 — 2026-07-05

### Fixed

- **`browser_dispatch_key` now populates `keyCode`/`which`** on the synthesized `KeyboardEvent` (both the ref and selector paths). Legacy React/Vue key handlers commonly branch on `e.keyCode === 13` rather than `e.key`, so Enter on tag/autocomplete inputs previously did nothing. The event remains untrusted (`isTrusted === false`), so a few libraries may still ignore it.
- **`browser_execute_js` IIFE auto-wrap no longer false-positives.** The wrap now triggers only when the trimmed source *starts with* a `return` statement, instead of whenever the string merely contained the substring `"return "` (which silently turned bare expressions — including ones mentioning `return` inside a string literal or comment — into `undefined`).

### Changed

- **`browser_fill` guidelines** now point at `browser_dispatch_key({ ref, key: 'Enter' })` for submitting tag/autocomplete inputs (not `browser_press_key`, which targets the focused element), and at the open → `browser_snapshot` → `browser_click` recipe for custom (div-based) dropdowns.

## 0.6.0 — 2026-06-21

### Added

- **Per-tab isolation for multi-agent safety.** Each agent's browser session now operates in a dedicated Chrome window with tab ownership tracking. Tabs opened via `browser_open_urls` and `browser_new_tab` are automatically registered in the ownership registry and tagged with a 🟢 prefix in the document title for user visibility. `browser_list_tabs` scoped to `"owned"` (default) only shows the current session's tabs.
- **Unix socket daemon with auto-reconnect.** The browser daemon now binds to a Unix-domain socket (`pi-browser.sock`) in the harness temp directory instead of a TCP port. The transport layer reconnects automatically when Chrome restarts — no manual `/browser-reload-daemon` needed.
- **On-demand browser initialization.** Chrome is no longer launched eagerly at harness startup. The harness attaches lazily on the first browser tool call, reducing resource usage when the agent isn't using the browser.
- **`browser_setup` as agent-callable tool.** The setup tool can now be called programmatically by agents, not just via slash command. Idempotent — safe to call when already connected.

### Fixed

- **Chrome detection on macOS** now matches by process-name substring instead of exact binary path comparison, fixing false negatives when Chrome is running from different installation paths (e.g. `/Applications/Google Chrome.app/` vs user-local copies).

### Added

- **`browser_console`** — new tool. Reads JS errors and console messages from the active tab via two CDP sources merged into one buffer: `Runtime.consoleAPICalled` (page `console.*` calls and uncaught exceptions) and `Log.entryAdded` (browser-level entries — CSP violations, mixed content, deprecations, network errors). Filters: `levels` (log/info/warn/error/debug), `textPattern` (substring; wrap in slashes for regex), `sinceMs`, `limit` (default 50, cap 500). Each record carries a monotonic `seq`; the response includes `nextCursor` so callers can pass `sinceSeq` to see only what's new since the previous drain — the cursor pattern that makes "what did this action cause?" answerable in one call. Buffer is page-scoped (cleared on tab switch) and bounded at 500 records; `bufferOverflowed` flag reports drops since the last drain. Stack traces (top 3 frames) are preserved for error/warn records. Per-arg cap of 2 KB prevents a single `console.log(hugeBlob)` from blowing the buffer.
- **`Log` CDP domain enabled** alongside Page/DOM/Runtime/Network/Accessibility on every attach. (`Runtime` was already enabled, so `Runtime.consoleAPICalled` was reachable; this adds the missing domain for browser-level entries.)
- **`browser_console` ships with a custom `renderResult`** following the established pattern — collapsed: header counts (`3 errors · 2 warnings · 47 logs`) + last 5 rows. Expanded: full list with stack traces inline as code fences. Appends `keyHint("app.tools.expand", ...)` so the binding label adapts to user remaps.

### Internal

- New pure module `src/cdp/console-buffer.ts` mirrors the `network-buffer.ts` pattern (insertion-ordered Map, FIFO eviction at capacity 500, overflow flag reset per drain). Wired into the existing single-consumer event loop in `src/cdp/session.ts`.

### Known follow-ups

- No tests added in this release. Verification is manual against real Chrome.

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
