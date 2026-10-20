# Code quality audit — todo list

Source: TypeScript/code-quality audit on 2026-10-19 (four parallel reviews over cdp, daemon, domains, profile/util/tests, plus an extensibility pass). Items marked **(verified)** were reproduced directly in source or by running code. Line numbers are as of commit bc60de5.

Baseline at audit time: typecheck passes, boundary scan passes with 8 exemptions, `npm test` = 365 tests, 356 pass, **1 fail**, 8 skipped.

**Status 2026-10-20: all items fixed except the two marked DEFERRED.** `npm run check` (typecheck incl. page-JS project, boundaries, ESLint strict-type-checked, tests) is green: boundary scan 6 exemptions, lint 0 errors, 1017 tests / 1009 pass / 0 fail / 8 platform skips. Line numbers below are still those of commit bc60de5 and no longer match the tree. Two extra bugs found while writing tests were fixed as well: `browser_handle_dialog` left the handled dialog recorded on the session, and `browser_press_key` sent function keys without a virtual key code.

---

## P0 — Production bugs (silent, affect every user)

- [x] **Tool errors never reach the model as errors** (verified). `src/util/tool.ts:93` sets `isError: true` on the returned result, but pi-agent-core's `AgentToolResult` has no such field and the agent loop hard-codes `isError: false` for any resolved `execute` (`node_modules/@mariozechner/pi-agent-core/dist/agent-loop.js:376`). Only a thrown error is flagged. Fix: throw from `execute` when the handler returns `!r.success` (or confirm pi has another channel), and add a test that asserts the pi-visible `isError`.
- [x] **Transport exits mid-handshake; failing test `test/daemon/transport-exit-test.ts`** (verified). `src/daemon/transport.ts:71` clears `connectTimer` on TCP `connect`, before the daemon's `registered` reply. The socket is already `unref()`'d (line 64), so with nothing else pending the process exits before registration. Reproduced: holding a ref across the handshake makes the fixture print `connected` and exit cleanly. Same early clear means a daemon that accepts but never registers hangs `connect()` forever. Fix: clear the timer only in `settle()` (registered / close / error).
- [x] **Bridge client cleanup never runs in the real daemon** (verified). `src/daemon/index.ts:27` and `:58` both call `ipcServer.onDisconnect`, but `src/daemon/server.ts:161` stores a single handler by assignment, so the idle-timer registration overwrites `cdpBridge.removeClient`. Disconnected clients leak router ownership, `generations` entries, and armed timers. Fix: make the server keep a handler list, or merge both callbacks into one.
- [x] **`--browser-namespace` flag has never worked** (verified). `src/index.ts:16` reads `pi.getFlag("browser-namespace")` before `registerFlag` at `:24`; pi's loader returns `undefined` for unregistered flags. Fix: read the flag inside the `session_start` handler (where `browser-debug-clicks` is already read correctly) and derive the namespace there before `createDaemonTransport`.

## P1 — Session lifecycle bugs in `src/cdp` (share one root cause: nothing owns a session's lifetime)

- [x] **CDP sessions are attached but never detached** (verified). `src/cdp/session.ts:292-308` (`switchTo`) re-attaches on every switch and keeps the old session alive with all domains enabled. Same in `attachFirstPage` (`:270-285`) and `src/cdp/target-factory.ts:564-568` (`sessionForTarget`). `src/client.ts:325-329` only detaches `current()`. Fix: reuse `existing.sessionId` when live, or detach the old session after a successful re-attach.
- [x] **Destroying the current target leaves `current()` non-null** (verified). `src/cdp/session.ts:103-115` prunes `tabs`/`sessionIdToTargetId` but not the module-level `sessionId`/`targetId`. `ensureAlive` (`src/client.ts:181-185`) trusts `current()` inside the 30s `HEALTH_TTL_MS`, so calls fail with `session_not_found` for up to 30s. Also the whole cleanup is gated on `if (!ownership) break;`, and `Inspector.detached` is in the events table but never handled.
- [x] **`attachFirstPage` re-attach leaves a stale sessionId mapping.** `src/cdp/session.ts:275-285` sets a new mapping without deleting the previous `tabs.get(pickTargetId)?.sessionId` (unlike `switchTo` at `:307`). Old-session console events land in the new tab's buffer → every console line recorded twice. Also discards the survivor's refMap/refSig/buffers.
- [x] **`onClose` comment contradicts behaviour.** `src/cdp/session.ts:159-166` says "Do NOT clear `dialog`" but `dialog` now lives on `TabSession` and `tabs.clear()` drops it. Either preserve the current tab's dialog or delete the comment.
- [x] **Enable/discover results are swallowed.** `src/cdp/session.ts:168-172` (`enableDomains`) discards all six `*.enable` results; `:198` discards `Target.setDiscoverTargets`. Network/console buffers or popup ownership can be silently dead. Return/aggregate the first failure or at least warn.
- [x] **A throwing event handler kills the consumer until next transport close.** `src/cdp/session.ts:152-156` has no per-event try/catch inside the `for await`; `src/daemon/queue.ts:17-20` then buffers events unbounded.

## P1 — Daemon bugs

- [x] **Connect timeout reported as `chrome_disconnected` to every client.** `src/daemon/bridge.ts:309-319` calls `failCurrentAttempt(true)` unconditionally; `onError`/`onClose` (`:386-399`) correctly gate on an established socket. With Chrome closed, every tool call kicks all clients off their daemon sockets. Gate notification on `sock !== null && isCurrentAttemptSocket(...)`.
- [x] **Overlapping `connect()` destroys the new socket.** `src/daemon/transport.ts:25-35` `cleanup` closes over the shared `socket` variable; a second `connect()` during an in-flight handshake (`:40` only short-circuits when `registered`) orphans the first socket, whose later `close` destroys the current one. Reachable via concurrent `client.ensureAlive` (`src/client.ts:181-183` has no mutex). Fix: capture `sock` in handlers / guard `connect()` with an in-flight promise.
- [x] **Detach-release in `handleRequest` checks the wrong field.** `src/daemon/bridge.ts:477-478` reads the envelope `req.sessionId`; the only caller (`src/client.ts:328`) puts the session in `params` and sends envelope `null`. Dead logic. Read `req.params?.sessionId` or delete.
- [x] **Duplicate-clientId reply is written then immediately destroyed.** `src/daemon/server.ts:76-77` `write(); destroy()` discards unflushed data. Use `socket.end(payload)`.
- [x] **`shutdown` referenced in a timer before its `const` declaration.** `src/daemon/index.ts:48` vs `:72`. Safe only because the first timer is 30 min out. Hoist `shutdown`.
- [x] **`deregister` is a protocol action nobody handles.** Sent by `transport.ts:140` and `spawn.ts:62`; `index.ts:12` drops it. Handle it (immediate `clients.delete` + disconnect handler) or remove from the union.
- [x] **Liveness probe string-matches the wire protocol.** `src/daemon/spawn.ts:58-61` `text.includes('"registered"')` bypasses `deserialize`. Use the real guard.
- [x] **`DAEMON_MAX_CLIENTS` counts registered clients only.** `src/daemon/server.ts:51`; anonymous sockets in `sockets` are unbounded.
- [x] **`waitForConnection` busy-polls at 5ms.** `src/daemon/bridge.ts:438-445`; the attempt already has `settledPromise` (`:265`). Also `:467-475` duplicates the guard at `:458-464`.

## P1 — Domain / tool bugs

- [x] **AbortController "time budgets" bound nothing.** `src/domains/network.ts:244-259`: `.map(async)` starts every call synchronously so the `aborted` check is always false and the signal is never passed to `cdpCall`. Same shape in `src/domains/snapshot.ts:135-149` (first check at `:139` dead; N `DOM.getBoxModel` calls unbounded). Pass the signal through or use a concurrency-limited runner.
- [x] **Ref signature is a `|`-joined string that gets re-split.** `src/domains/ref-resolve.ts:46` + `:81-83, :97-100`; an element named `Save | Cancel` corrupts the diff. Format string is duplicated by hand in `src/domains/snapshot.ts:155`. Store a `{ role, name, value, state }` struct in the session.
- [x] **`browser_print_to_pdf` throws on an unwritable path.** `src/domains/files.ts:264-265` `writeFile` has no try/catch and `registerBrowserTool` (`tool.ts:165-183`) has no catch around `def.handler`. Return `kind: "io_error"` like `verifyReadable` (`files.ts:30-40`) does.
- [x] **Tab-title marker applied to the wrong document.** `src/domains/navigate.ts:111-117` evaluates `document.title='🟢 '+…` right after `Page.navigate` returns (navigation *started*), so the loaded document overwrites it. Also `evalJs(...).catch(() => {})` is dead (Result never rejects); same dead `.catch` at `src/domains/isolated-tab.ts:90`.
- [x] **Shape mismatches reported as "No element matched".** `src/domains/form.ts:48-56`, `:125-128`, `:207-210` treat `isPageResult(r.data) === false` the same as `reason === "not_found"`, misleading the model into trying other selectors.
- [x] **Ref path of `runOnElement` leaks RemoteObjects and skips `awaitPromise`.** `src/domains/element-call.ts:51-65` never calls `Runtime.releaseObject` (sibling `resolveAndCall` at `:109-111` does, in `finally`); same leak at `src/domains/keyboard.ts:150-157`. Two different not-found sentinels: `{ status: "not_found" }` (`element-call.ts:74`) vs `{ ok: false, reason: "not_found" }` (`form.ts:21`).
- [x] **`waitFor` can throw on abort.** `src/domains/page.ts:143` `await sleep(50, signal)` rejects on abort and is not caught, while `waitTool` at `:66-71` catches. Abort kind is `internal` in `page.ts:94,136`, `isolated-tab.ts:65` but `invalid_state` in `tool.ts:160`.
- [x] **`browser_execute_js` persists up to 400 KB per call.** `src/domains/js.ts:58-63` stores `full` and `pretty` (≤200 000 chars each) in details purely for `renderResult`.
- [x] **`read-page.ts:145`** attaches to an owned tab via `Target.attachToTarget` and never detaches.

## P1 — Profile / util bugs

- [x] **sharp "missing" misclassified as "error" under ESM** (verified). `src/util/sharp-shim.ts:19-23` matches substrings against `e.message`; Node 22 throws `code=ERR_MODULE_NOT_FOUND`, `message="Cannot find package 'sharp' imported from …"`. Users see "sharp failed to load" instead of "install sharp". Use `errnoCode(e)` from `src/util/guards.ts:27`.
- [x] **`isPathWithin` false-rejects siblings starting with `..`.** `src/util/paths.ts:12` `!rel.startsWith("..")` rejects `/a/..foo`. Use `rel !== ".." && !rel.startsWith(".." + sep)`.
- [x] **`BH_DEBUG_CLICKS=0` / `=false` enables debug.** `src/util/debug.ts:8` `Boolean(env[...])`.
- [x] **Linux `chromium-browser` comm entry is unreachable.** `src/profile/browser-process.ts:22-25`; `ps -o comm=` truncates to 15 chars. Also `:141` `cmdline.split(" ")[0]` breaks on argv[0] with a space.
- [x] **Discovery can block 30s per stale `DevToolsActivePort`.** `src/cdp/discovery.ts:507-521` waits sequentially with `PORT_PROBE_DEADLINE_MS = 30_000` per candidate before fallback ports. Probe concurrently or only the newest-mtime candidate.

---

## P2 — Type-safety holes (compile today, let real bugs through)

- [x] **Optional params on every CDP method** (verified). `src/cdp/session.ts:35,37` `call`/`callBrowser` take `params?: ParamsOf<M>`, so `call("Page.navigate")` compiles. Use a conditional tuple: `...args: {} extends ParamsOf<M> ? [params?, opts?] : [params, opts?]`. (`callOnTarget` at `:36` is already correct.)
- [x] **Whole Input domain untyped.** `src/cdp/commands.ts:222-224` `Input.dispatchMouseEvent/KeyEvent/DragEvent` = `Type.Object({}, { additionalProperties: true })`; also `:235` `Emulation.setDeviceMetricsOverride`, `:157` `Page.printToPDF`. Forces `Record<string, unknown>` at `keyboard.ts:95`, `drag.ts:39`; typos in `clickCount`/`pointerType` compile. Also `:121` `behavior: Type.String()` → literal union; `:150` `format` → `"jpeg"|"png"|"webp"`.
- [x] **Tool results untyped end to end.** `src/util/tool.ts:17` `details?: Record<string, unknown>`, `:55` `renderResult(result: AgentToolResult<unknown>)`. Each tool hand-writes guards to read back its own output: `network.ts:167-216` (50 lines), `console.ts:112-152`, `snapshot.ts:185-195`, `js.ts:68-75`, `screenshot.ts:42-47`. Add a second generic `BrowserToolDefinition<S, D>`; on replay validate with TypeBox `Compile` + `parseJson` as `read-page.ts:42-49` and `web-search.ts:59-66` already do.
- [x] **Function-cast exemption is avoidable.** `src/util/tool.ts:60-64` erases `renderCall` to `never` and `:116-118` casts back. Build pi's `ToolDefinition<S>` inside `defineBrowserTool` while `S` is bound and expose an erased `{ name, label, …, register(pi, client) }` closure. Removes the exemption and the `as unknown as AnyBrowserToolDefinition` ducks in `test/domains/registry-test.ts:111`, `daemon-socket-test.ts:156`.
- [x] **Guards claim fields they never check.** `src/cdp/types.ts:53-54,90-106` `isCdpRawMessage` types `params` as Record but never validates it; same for `src/daemon/protocol.ts:7,44-65` `isWireMessage` (a string `params` reaches Chrome at `bridge.ts:500`). Check with `isRecord` or type as `unknown`.
- [x] **`WireControl` not discriminated by action.** `src/daemon/protocol.ts:29-34` puts `clientId?`/`reason?` on all four actions; `transport.ts:79` and `server.ts:67-68` re-check what the guard proved. Per-action union + `const ACTIONS = [...] as const`.
- [x] **`PageResult` is a nine-optional bag.** `src/domains/element-call.ts:8-18`; `form.ts:57-71` needs `res.reason ?? "unknown reason"` and stringly `res.kind === "select"`. Make it `{ ok: true; kind: …} | { ok: false; reason: string }` with literal `kind`. (`form.ts:95` `FocusResult` and `:147-151` `SelectResult` are the good pattern.)
- [x] **`ToolErrKind` has no `invalid_args`.** `src/util/tool.ts:20-26`; `form.ts:201`, `files.ts:125,202,210`, `page.ts:126`, `js.ts:147,151`, `read-page.ts:168`, `target.ts:34`, `tabs.ts:100` all overload `invalid_state`.
- [x] **`SetupResult` hand-rolls `Result<string, string>`.** `src/setup.ts:22`, not readonly.
- [x] **Duplicate, divergent guards.** `src/profile/list.ts:38-42` redefines `asRecord` (returns `null`) and `asString` (rejects empty) with different contracts from `src/util/guards.ts`. Pick one.
- [x] **`Result` helper set is both incomplete and barely used.** `src/util/result.ts` has `ok/err/map`; `map` is used in one file; no `andThen`/`mapErr`. Grow it and use it, or drop `map`.
- [x] **`pageInfo()` returns a non-discriminated union.** `src/client.ts:43` `PageInfo | { dialog }`; callers use `"dialog" in`. Add a `kind` tag.
- [x] **`OwnershipRegistry.onChange` is a single-slot setter named like a subscription.** `src/cdp/ownership.ts:216,274-276`; no unsubscribe, second caller silently replaces. Return a disposer like `CdpTransport.onClose`.
- [x] **Readonly discipline breaks in exactly the detail/buffer types.** `src/domains/snapshot.ts:85-92`, `network.ts:157-165`, `console.ts:100-108` (mutated after construction, e.g. `snapshot.ts:178`); `src/cdp/network-buffer.ts:4-34` and `console-buffer.ts:6-29` export mutable records/filters; `network.ts:250,256` write `r.body` into drained buffer objects. Split into internal mutable + exported readonly types.
- [x] **`setRefMap` aliases the caller's Map.** `src/cdp/session.ts:323-327`; `refMappings()` returns it as `ReadonlyMap` but the caller can still mutate.

## P2 — Duplication and consistency

- [x] **Twelve hand-rolled `{ kind: "cdp_error", message }` wraps** that drop timeout kind and `details.method`: `navigate.ts:33,37,47,91`, `tabs.ts:28,92,119,142,191`, `scroll.ts:29`, `page.ts:37`, `history.ts:68`. `cdpErrToToolErr` (`cdp-call.ts:7-11`) already exists; `isolated-tab.ts:20,26` uses it. Add `fromClient(r)` or wrap the client methods in `cdp-call.ts`.
- [x] **Three readyState poll loops, three sleeps.** `page.ts:90-103`, `page.ts:135-144`, `isolated-tab.ts:57-71`. Extract `pollUntil(client, expr, { timeoutMs, signal, sessionId })`.
- [x] **Tab prefix resolution duplicated with divergent semantics.** `tabs.ts:86-116` (switch: resolves against all tabs then ownership-checks) vs `tabs.ts:166-189` (close: owned only). Extract `resolveOwnedTargetId`.
- [x] **Ownership pruning duplicated three times.** `src/cdp/session.ts:203-208`, `src/client.ts:257-262`, `src/cdp/target-factory.ts:628-648`; `client.ts:279-280` `newTab` calls `listTabs(true)` purely for the side effect. Extract `reconcileOwnership(ownership, liveTargetIds)`.
- [x] **`attachFirstPage` is ~90 lines doing four jobs.** `src/cdp/session.ts:197-288`: discovery, ownership pruning + N `Browser.getWindowForTarget` round-trips, tab-map pruning, target selection, attach+enable.
- [x] **`browser_open_urls` handler does seven jobs in 70 lines.** `src/domains/navigate.ts:85-157`; two near-identical `details` spreads at `:150`/`:155`. `read-page.ts:118,139` types the client as `Parameters<typeof openIsolatedTab>[0]` instead of importing `BrowserClient`.
- [x] **`interactiveDiff` is a diff in name only.** `src/domains/ref-resolve.ts:49-118` refetches the full AX tree, rewrites the session ref map as a side effect (`:78`), and returns `""` on CDP failure (`:54`). Split into `refreshRefs()` returning a Result and a pure `diffSignatures(prev, cur)`.
- [x] **bridge.ts `attempt` closure duplicates bookkeeping.** `src/daemon/bridge.ts:259-408` checks `!isCurrentAttempt(generation) || stopped` four times though `isCurrentAttempt` already includes `!stopped` (`:236-237`); `failCurrentAttempt` + `settleAttempt` both call `rejectAttemptCallbacks` (`:277,:304`); `generations` map (`:147`) duplicates `clientId` in `InFlight` (`:29`). Fold `generation` into `InFlight`, give the multiplexer `takeWhere(pred)`, move the connection state machine to its own file.
- [x] **`ensureAlive` treats any non-`session_not_found` probe failure as alive, undocumented.** `src/client.ts:192-206`; also `:186` uses raw `transport.request` instead of `session.callBrowser`. Document the reason or fix.
- [x] **Minor dead/unused surface.** `src/daemon/transport.ts:116` dead duplicate error listener; `bridge.ts:61-66` `takeAll` and `:22,:522` `getSessionOwner` only used by tests; `src/client.ts:126` `let pageCaches` never reassigned; `client.ts:311` `.catch(() => {})` on a Result-returning call and `ownership.remove(id)` runs even when close failed; `commands.ts:251` / `events.ts:422` unreachable `spec === undefined` branches; `network-buffer.ts:83-85` load-bearing `delete`-then-`set` has no comment; `CdpBridge`/`IpcServer` method signatures not `readonly` unlike the rest of the layer; `transport.ts:37` `connect(_url)` ignores its argument.

## P2 — Injected page JS

- [x] **Page-side JS is not type-checked anywhere.** `fill-engine.ts:6-74` (70 lines in a string), `form.ts:104-109,171-185,230-245`, `ax-tree.ts:166-170`, `web-search.ts:29-54`, `read-page.ts:53-84`. Only fill-engine has tests. Consider `*.page.js` files with `// @ts-check` + DOM lib, read at build time.
- [x] **Two files bypass `safeJs`.** `web-search.ts:29` and `read-page.ts:53` build expressions with raw template literals, contradicting `js-template.ts:1`. Safe today (only numeric constants interpolated) but `check-boundaries.ts` has no rule for it. Add a `raw-js-template` boundary rule. Injection audit otherwise clean.

---

## P3 — Tests and tooling

- [x] **No tests for the entire `src/domains/` tool layer** (ax-tree, cdp-call, click, console, dialog, drag, element-call, history, js, keyboard, navigate, network, page, render, screenshot, screenshot-capture, scroll, setup, snapshot, tabs, viewport, read-page, web-search), nor for `src/util/js-template.ts` (the one sanctioned injection barrier), `src/util/mutex.ts`, `src/util/sharp-shim.ts`, `src/util/truncate.ts`, `src/schemas/common.ts`, `src/cdp/target-factory.ts`, `src/daemon/index.ts`, `src/index.ts`, `src/setup.ts`, `src/profile/bind.ts`, `src/profile/command.ts`.
- [x] **No type-level tests.** Zero `expectTypeOf` / `@ts-expect-error` / `satisfies` in `test/`. Add tests for `ResultOf<M>`/`ParamsOf<M>` shapes, `Result` narrowing, and the optional-params fix above.
- [x] **Test fakes use `as unknown as` ducks** that typecheck never validates: `test/domains/registry-test.ts:76,83,92,111`, `test/domains/target-test.ts:6,20`, `test/util/state-test.ts:15`. (`test/domains/fake-client.ts` is the good model: full `BrowserClient` literal, no cast.)
- [x] **Add type-aware ESLint.** No eslint/biome config exists. Add typescript-eslint `strict-type-checked` with `no-unsafe-*`, `consistent-type-assertions` (objectLiteralTypeAssertion: never), `no-non-null-assertion`, `no-explicit-any`, applied to `src/` **and** `test/`.
- [x] **Boundary script false negatives.** `scripts/check-boundaries.ts`: only scans `src/` (line 93); misses `<Type>expr` angle casts, `as string`/`as number`/lowercase targets, `satisfies`, bare `Function`/`object` types; scans comments/strings; cannot see `Record<string, unknown>` dumping grounds. Keep it for the `raw-cdp-call`/`raw-evaluate` rules and let ESLint own cast policy.

## P3 — Extensibility

- [x] **Generate the prompt lane list from the registry.** `src/prompt.ts:16` hand-lists serialized vs observational tools, duplicating each tool's `concurrency` field; drifts silently.
- [x] **Skill file names only 16 of 42 tools.** `skills/pi-browser-harness/SKILL.md`; generate or add a sync check.
- [x] **No third-party tool registration.** `ALL_TOOLS` is hardcoded and the client lives in a closure in `src/index.ts`. Decide whether external extensions should be able to register browser tools sharing the client/mutex/ownership; if yes, expose a registration function.
- [ ] **Per-tab state is a closed struct.** DEFERRED by decision (no concrete consumer yet); documented under "Known limits" in README Extending. `TabSession` in `src/cdp/session.ts` hard-codes buffers; a new captured-data kind touches four files. Consider a per-tab extension slot.
- [ ] **Browser list is hardcoded.** DEFERRED by decision; escape hatches documented under "Known limits" in README Extending. `src/profile/paths.ts:31-…` and `src/profile/browser-process.ts:22-25`; only `CHROME_USER_DATA_DIR` / `BU_CDP_WS` as escape hatches. Acceptable until a concrete need.
- [x] **Daemon protocol grows by hand.** See `WireControl` item above; a discriminated union with a derived `ACTIONS` const fixes this.

## P3 — Repo hygiene

- [x] **`docs/` holds ~20 unrelated personal research files** (interview prep, salary guides, etc.) and the repo root has stray scripts/reports (`yt_*.js`, `linkedin_scan.mjs`, `*_research.md`, `*_report.md`). Not shipped (`files` in package.json limits the tarball), but a new contributor opening `docs/` finds nothing about the project. Move them out or gitignore them.
