# pi-browser-harness — internal rewrite (v0.3.0)

**Date:** 2026-05-02
**Scope:** internals only (`src/`); no tests, no CI changes
**LLM-facing API posture:** frozen tool names; normalized parameter names and unified `details` schema
**Code-quality bar:** strict TypeScript, no `any`, factory functions, `Result<T, E>`, TypeBox-derived types, immutable data

---

## 1. Why

The harness works but is hard to change safely. Two files dominate the codebase: `daemon.ts` (1140 LOC) and `tools.ts` (1818 LOC). The same six-line try/catch + error-formatting block is copy-pasted across 28 tools. Several bugs and one full-RCE security gap stem from missing module boundaries rather than from careless coding.

This rewrite restructures the internals so that:

- the same bug class can't recur (structural prevention, not vigilance)
- adding a new tool is a single file under `src/domains/`
- every tool exposes a uniform `Result`-shaped contract to the LLM
- the package's external surface (28 tool names, the system prompt, the npm package name) stays compatible at the *name* level; only parameter names and return-detail shapes change

## 2. Current-state audit (problems that drive the design)

### 2.1 Structural

- `daemon.ts` is one God class doing transport, session management, reconnect, dialog detection, event buffering, page-info caching, screenshots, file upload, drag, PDF, viewport, network log, and key-code maps.
- `tools.ts` is 28 tool registrations inline. Each tool repeats the `await daemon.ensureAlive()` → `try { … } catch (err) { return { isError: true, content: [{type:"text", text: \`X failed: ${err instanceof Error ? err.message : String(err)}\`}], details: undefined } }` pattern. ~30 lines × 28 tools = ~800 lines of pure noise.
- `details` field is inconsistent: most tools return `undefined`, a few return rich objects. The agent has no contract to parse.
- `index.ts` has a `tool_result` hook that reads `details.targetId` from `browser_new_tab` / `browser_navigate` — but those tools never set it. Dead code.
- `state.ts` persists `tabHistory`, `screenshotDir`, `debugClicks` — none are read.
- `renderers.ts` registers a renderer for a message type that's never produced.

### 2.2 Predictability bugs

| # | Bug |
|---|---|
| 1 | `browser_navigate` outer try/catch silently makes a new tab when navigation fails — masks the real error |
| 2 | `getPageInfo()` clears `_currentDialog` on read; two callers in the same tick disagree |
| 3 | `browser_wait_for_load` returns `true` from the initial `readyState === "complete"` check even if a navigation just kicked off and the previous page hasn't unloaded |
| 4 | `browser_open_urls` swallows phase-2 errors but lets `onUpdate` errors propagate uncaught |
| 5 | `browser_dispatch_key` reports success even when the selector matched zero elements |
| 6 | Optional `sharp` dependency: real sharp errors are reported as "install sharp for auto-resize" |
| 7 | Background reconnect on `ws.onclose` can stack consent popups; `_consentObserved` flag is a workaround for this |
| 8 | `browser_scroll` — description and code disagree on default direction |
| 9 | `browser_screenshot` returns `{path, format, quality}` but agent has no signal about whether the image was actually attached |
| 10 | `_eventBuffer` survives reconnects with stale events from the previous connection |
| 11 | Page-info cache lives on the daemon and outlives navigations not initiated by `Page.navigate` (e.g. SPA route changes) |
| 12 | Screenshot path uses `Date.now() + global counter` — concurrent calls within the same millisecond collide |
| 13 | `browser_http_get` 20 s timeout aborts the headers read but not `await response.text()` — body read can hang |

### 2.3 Security gaps

| # | Gap |
|---|---|
| S1 | JS-injection in error-message templates: `daemon.uploadFile` and `browser_dispatch_key` use `selector.replace(/'/g, "\\'")` — broken for backslashes, newlines, unicode quotes, `</script>` |
| S2 | `browser_run_script` is unsandboxed RCE: `new AsyncFunction(...)` over arbitrary file contents with `daemon`, `require`, `Buffer`, `fetch` bound; the documented `signal` is never honored; no timeout enforced; no path allowlist |
| S3 | `setDownloadBehavior` accepts any path; Chrome silently downloads to nowhere if the dir doesn't exist or isn't writable |
| S4 | `uploadFile` doesn't verify the file is readable before issuing CDP calls; can leave the input in a half-set state |

## 3. Module layout

```
src/
  index.ts                       extension entry: lifecycle, hooks, prompt injection
  prompt.ts                      system-prompt builder
  state.ts                       branch state (pruned: dead fields removed)
  setup.ts                       /browser-setup command
  registry.ts                    iterates domain modules → pi.registerTool

  cdp/
    transport.ts                 WebSocket multiplex: send, request/response, event stream
    session.ts                   target attach/switch/recover, dialog buffer, event buffer
    discovery.ts                 DevToolsActivePort lookup + port probe
    errors.ts                    CdpError, SessionNotFoundError, TimeoutError
    types.ts                     CDPMessage, CDPEvent, RawCdpResult

  client.ts                      BrowserClient factory: composes transport+session,
                                 exposes the high-level surface every domain calls

  domains/
    navigate.ts                  browser_navigate, browser_open_urls
    history.ts                   browser_go_back, browser_go_forward, browser_reload
    click.ts                     browser_click
    keyboard.ts                  browser_type, browser_press_key, browser_dispatch_key
    scroll.ts                    browser_scroll
    screenshot.ts                browser_screenshot (+ debug overlay)
    tabs.ts                      browser_list_tabs, browser_current_tab, browser_switch_tab,
                                 browser_new_tab
    page.ts                      browser_page_info, browser_wait, browser_wait_for_load
    dialog.ts                    browser_handle_dialog
    js.ts                        browser_execute_js, browser_run_script
    files.ts                     browser_upload_file, browser_download, browser_print_to_pdf
    viewport.ts                  browser_viewport_resize
    drag.ts                      browser_drag_and_drop
    network.ts                   browser_http_get, browser_get_network_log

  schemas/
    common.ts                    shared TypeBox primitives (Coords, Modifiers, etc.)

  util/
    result.ts                    Result<T,E> + ok/err/map/andThen
    tool.ts                      defineTool() helper — the boilerplate-killer
    truncate.ts                  output truncation + temp-file fallback
    keycodes.ts                  pure key-code maps
    paths.ts                     namespaced screenshot paths (UUID, no global counter)
    js-template.ts               safeJs() — always JSON.stringify interpolated values
    time.ts                      sleep, deadline helpers
```

**Deleted:** `protocol.ts` (types moved to `cdp/types.ts` and `client.ts`), `renderers.ts` (the one renderer is dead; per-tool renderers stay in their domain files).

**File-size targets:** every file ≤ 300 LOC. Largest expected: `cdp/transport.ts` (~250), `domains/js.ts` (~200). Most domain files: 60–120 LOC.

**Dependency direction:** `domains/* → client → cdp/* → util/*`. Domains never reach into transport directly. Transport never knows about tools.

## 4. The `defineTool` helper

```ts
// util/tool.ts

import type { TSchema, Static } from "typebox";
import type { ExtensionAPI, ToolContext, ToolResult } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "../client";
import type { Result } from "./result";

export type ToolOk = {
  readonly text: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type ToolErrKind =
  | "not_connected"
  | "cdp_error"
  | "timeout"
  | "invalid_state"
  | "io_error"
  | "internal";

export type ToolErr = {
  readonly kind: ToolErrKind;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type HandlerContext = {
  readonly client: BrowserClient;
  readonly signal: AbortSignal;
  readonly onUpdate: (update: ToolOk) => void;
  readonly extensionCtx: ToolContext;
};

export type ToolHandler<S extends TSchema> = (
  args: Static<S>,
  ctx: HandlerContext,
) => Promise<Result<ToolOk, ToolErr>>;

export type ToolDefinition<S extends TSchema> = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: ReadonlyArray<string>;
  readonly parameters: S;
  readonly handler: ToolHandler<S>;
  readonly renderCall?: (args: Static<S>, theme: unknown) => unknown;
  readonly renderResult?: (result: ToolResult, opts: { expanded: boolean }, theme: unknown) => unknown;
  readonly ensureAlive?: boolean;   // default true
};

export const defineTool = <S extends TSchema>(def: ToolDefinition<S>) => def;

export const registerTool = <S extends TSchema>(
  pi: ExtensionAPI,
  client: BrowserClient,
  def: ToolDefinition<S>,
): void => {
  pi.registerTool({
    name: def.name,
    label: def.label,
    description: def.description,
    promptSnippet: def.promptSnippet,
    promptGuidelines: [...def.promptGuidelines],
    parameters: def.parameters,
    renderCall: def.renderCall,
    renderResult: def.renderResult,
    async execute(_id, args, signal, onUpdate, extensionCtx) {
      if (def.ensureAlive !== false) {
        const alive = await client.ensureAlive();
        if (!alive.success) {
          return toToolResult(
            { success: false, error: { kind: "not_connected", message: alive.error.message } },
            def.name,
          );
        }
      }
      const result = await def.handler(args as Static<S>, {
        client,
        signal,
        onUpdate: (u) => onUpdate?.({ content: [{ type: "text", text: u.text }], details: u.details }),
        extensionCtx,
      });
      return toToolResult(result, def.name);
    },
  });
};

const toToolResult = (
  r: Result<ToolOk, ToolErr>,
  toolName: string,
): ToolResult => {
  if (r.success) {
    return {
      content: [{ type: "text", text: r.data.text }],
      details: { ok: true, ...(r.data.details ?? {}) },
    };
  }
  return {
    isError: true,
    content: [{ type: "text", text: `${toolName} failed (${r.error.kind}): ${r.error.message}` }],
    details: { ok: false, kind: r.error.kind, message: r.error.message, ...(r.error.details ?? {}) },
  };
};
```

The helper is the only place that converts a handler's `Result` into pi's `ToolResult`. `details` is unified:

- success: `{ ok: true, …handlerDetails }`
- error:   `{ ok: false, kind, message, …handlerDetails }`

The agent always sees `details.ok` and `details.kind` and can branch.

### 4.1 Frozen names, normalized params

| Tool | Old param | New param | Why |
|---|---|---|---|
| `browser_click` | `clicks` | `count` | matches CDP `clickCount` |
| `browser_dispatch_key` | `event` | `eventType` | clearer + validates against literal union |
| `browser_click` | `button: string` | `button: "left" \| "right" \| "middle"` | actually validates |
| `browser_press_key` | `modifiers: number` | `modifiers: number` (TypeBox `Integer`, range 0–15) | rejects nonsense |
| (all) | implicit defaults via `??` | TypeBox `default:` field | one source of truth |

## 5. Transport / session split

```ts
// cdp/transport.ts — owns ONLY the WebSocket
export interface CdpTransport {
  connect(url: string, opts: { timeoutMs: number }): Promise<Result<void, CdpError>>;
  close(): Promise<void>;
  request(method: string, params: object, opts: { sessionId: string | null; timeoutMs: number }): Promise<Result<unknown, CdpError>>;
  events(): AsyncIterable<CdpEvent>;
  state(): "open" | "closed" | "connecting";
}

// cdp/session.ts — target attach/switch + buffered events
export interface CdpSession {
  attachFirstPage(): Promise<Result<{ targetId: string; sessionId: string }, CdpError>>;
  switchTo(targetId: string): Promise<Result<void, CdpError>>;
  current(): { sessionId: string; targetId: string } | null;
  call(method: string, params?: object): Promise<Result<unknown, CdpError>>;
  callOnTarget(method: string, params: object, sessionId: string): Promise<Result<unknown, CdpError>>;
  takeDialog(): DialogInfo | null;
  drainEvents(filter?: (e: CdpEvent) => boolean): ReadonlyArray<CdpEvent>;
  onClose(cb: () => void): void;
}

// client.ts — composes everything; what domains see
export interface BrowserClient {
  readonly ensureAlive: () => Promise<Result<void, CdpError>>;
  readonly status: () => DaemonStatus;

  readonly input: { click; type; pressKey; dispatchKey; scroll; drag };
  readonly nav:   { navigate; newTab; goBack; goForward; reload; openUrls };
  readonly tabs:  { list; current; switch };
  readonly page:  { info; waitForLoad; dialog };
  readonly screenshot: { capture; captureWithCrosshair; printPdf };
  readonly files: { upload; configureDownloads };
  readonly viewport: { resize };
  readonly net:   { httpGet; networkLog };
  readonly js:    { evaluate; runScript };

  readonly raw: (method: string, params?: object, sessionId?: string) => Promise<Result<unknown, CdpError>>;
}
```

### 5.1 Bugs fixed structurally by this split

1. **Stale event buffer (audit #10).** `events()` is an `AsyncIterable` bound to one connection. When the WS closes, the iterator ends; the next connection starts a fresh stream. There is no shared buffer to leak.
2. **Stale page-info cache (audit #11).** Cache lives in `client.page` and subscribes to `Page.frameNavigated` / `Page.loadEventFired` from `session.drainEvents()`. Invalidation is automatic — the 5 manual `invalidatePageInfoCache()` calls go away.
3. **Dialog read-and-consume race (audit #2).** `session.takeDialog()` is the only mutator; `client.page.info()` returns `{ dialog?, page? }` without mutating state.
4. **`browser_navigate` silent fallthrough (audit #1).** `client.nav.navigate()` returns `Result<NavOutcome, CdpError>` where `NavOutcome = {kind: "in_place", …} | {kind: "new_tab_created", reason: "no_tabs" | "internal_url"}`. The domain reports the outcome verbatim.
5. **HTTP-GET body read can hang (audit #13).** `client.net.httpGet` uses one `AbortSignal` whose timeout covers `await response.text()`.
6. **Screenshot path collisions (audit #12).** `util/paths.ts` returns `pi-browser-screenshot-${namespace}-${randomUUID()}.png`. No counter, no `Date.now()` collisions.

### 5.2 Reconnect behavior change

Today: `ws.onclose` schedules a background reconnect that may or may not succeed; in-flight requests reject with no retry.

Rewrite: reconnect is **lazy** — `ensureAlive()` is the only path that opens a new connection, and `defineTool` calls it before every tool runs.

- One in-flight failure → one error reported to the agent (clear).
- Next tool call → `ensureAlive` heals it (transparent).
- No silent stacked Chrome consent popups (the existing `_consentObserved` flag is removed because the failure mode is gone).

## 6. Security fixes

### 6.1 JS injection in error-message templates (S1)

```ts
// util/js-template.ts
export const safeJs = (strings: TemplateStringsArray, ...values: unknown[]): string => {
  let out = strings[0] ?? "";
  for (let i = 0; i < values.length; i++) {
    out += JSON.stringify(values[i]);
    out += strings[i + 1] ?? "";
  }
  return out;
};
```

Every JS-injection site (`uploadFile` fallback, `dispatch_key`, `getPageInfo`, debug overlay's `devicePixelRatio`) becomes `safeJs\`document.querySelector(${selector})\``. The `safeJs` helper is the **only** way to build evaluation source in the codebase. The pattern is documented in `client.js.evaluate`'s JSDoc.

### 6.2 `browser_run_script` — bounded escape hatch (S2)

The full RCE is fundamental; we tighten the contract instead of trying to sandbox:

1. **Path allowlist.** Refuse paths outside `tmpdir()`, `process.cwd()`, or `BH_SCRIPT_DIR`. Returns `{ kind: "invalid_state", message: "script path outside allowed directories" }`.
2. **Mandatory timeout.** Default 60 s, configurable via `timeoutMs` (max 600 s). When the AbortSignal fires, the script's `signal` is aborted *and* a hard timer rejects the outer promise.
3. **AbortSignal actually wired.** Outer promise is `Promise.race([scriptPromise, abortPromise])` so cancellation works even if the script ignores `signal`.
4. **Return-shape validator.** Validate every content item against a TypeBox schema, not just `Array.isArray`.
5. **Source size cap.** Refuse scripts > 1 MB.

We do not sandbox via `vm`/`worker_threads` — that breaks the `daemon` binding's purpose. The doc string makes the trust boundary explicit: "this tool runs arbitrary JS with full Node permissions; only invoke when the user has approved a script you wrote to disk."

### 6.3 Misc (S3, S4)

- `setDownloadBehavior` validates the path is an existing writable directory before calling CDP.
- `uploadFile` validates the file exists and is readable before any CDP call.
- `dispatch_key` returns `Result<{ matched: number }, …>` so the agent can detect zero-match selectors.

## 7. Predictability fixes register

| # | Today | Rewrite |
|---|---|---|
| 1 | `browser_navigate` silently makes a new tab on error | Returns explicit `{kind: "in_place" \| "new_tab_created" \| "failed"}` |
| 2 | `getPageInfo()` clears `_currentDialog` on read | `takeDialog()` is the only mutator; `info()` is read-only |
| 3 | `wait_for_load` returns true if `readyState === "complete"` immediately | Subscribes to `Page.frameStartedLoading` first; only returns true after `loadEventFired` or timeout |
| 4 | `open_urls` swallows phase-2 errors, propagates `onUpdate` errors | All errors classified the same way; `onUpdate` failures caught |
| 5 | `dispatch_key` reports success on zero matches | Returns `matched` count; zero matches = error |
| 6 | `sharp` failures reported as "install sharp" | Distinguish "module not found" from "sharp threw" |
| 7 | Background reconnect can stack consent popups | Lazy reconnect via `ensureAlive` only |
| 8 | `scroll` description / code disagree on default direction | Description matches code, code matches W3C wheel-event convention |
| 9 | `screenshot` doesn't tell agent if image was attached | Always returns `{ ok: true, path, attached: true \| false }` |
| 10 | Tab-history tracking in `index.ts` is dead code | Deleted; `state.ts` keeps only `namespace` and `remoteBrowserId` |
| 11 | `renderers.ts` registers a renderer for a message type nobody emits | File deleted; renderers live in domain files that produce them |
| 12 | `getVirtualKeyCode` / `getKeyCode` on the daemon class but pure | Moved to `util/keycodes.ts`, exported as pure functions |

**Prompt impact:** the system prompt in `prompt.ts` gets one-line updates for items 1, 3, 5, 8, 9. The 28 tool names and their descriptions are unchanged.

## 8. tsconfig + style enforcement

```json
{
  "compilerOptions": {
    "target": "ES2022",
    "module": "ESNext",
    "moduleResolution": "bundler",
    "strict": true,
    "noImplicitAny": true,
    "strictNullChecks": true,
    "noUnusedLocals": true,
    "noUnusedParameters": true,
    "noImplicitReturns": true,
    "noFallthroughCasesInSwitch": true,
    "noUncheckedIndexedAccess": true,
    "exactOptionalPropertyTypes": true,
    "noPropertyAccessFromIndexSignature": true,
    "forceConsistentCasingInFileNames": true,
    "esModuleInterop": true,
    "skipLibCheck": true,
    "outDir": "./dist",
    "rootDir": "./src",
    "declaration": true,
    "declarationMap": true,
    "sourceMap": true
  },
  "include": ["src/**/*.ts"]
}
```

Hard rules enforced by review:

- Zero `any`, zero `as Foo` assertions, zero `@ts-ignore`. The current `as any` for sharp dynamic-import is replaced with a typed shim file declaring the minimal interface used.
- All exported types use `readonly` properties and `ReadonlyArray<T>`.
- Public functions taking ≥3 args take an options object.
- Factory functions, not classes (`BrowserDaemon` class becomes `createBrowserClient(opts)`).
- `Result<T, E>` for every operation with an *expected* failure mode (everything CDP does); `throw` reserved for invariant violations.
- TypeBox schemas defined per-domain; types derived via `Static<typeof Schema>` and never re-declared by hand.

## 9. Migration notes

- Package version bumps to `0.3.0`. Same external surface; normalized parameter names.
- `CHANGELOG.md` records every renamed parameter (`clicks → count`, `event → eventType`).
- `benchmark/` JS files that import from `src/daemon` need `src/client` imports updated. Listed as a follow-up; benchmarks are not run by CI.
- `protocol.ts` deletion: the package's `files` entry exports the whole `src/` directory, so external code *could* in theory have imported types from `pi-browser-harness/src/protocol`. We treat this as private (it's not part of the documented surface) and don't add a re-export shim. If a downstream user reports breakage, we add a one-line re-export at the package root in a patch release.

## 10. Out of scope

- No tests added. Existing `benchmark/` JS files untouched (except import paths).
- No new tools beyond what exists today. Comparison-doc gaps (cookies, iframe helpers, profile sync, cloud browsers) are a follow-up.
- No CI changes. No linter setup.
- The `skills/` directory shipped with the package is untouched.
- No changes to `package.json` peer-dependency declarations beyond the version bump.

## 11. Verification (manual smoke)

After implementation, the implementer runs the existing `benchmark/run-benchmark.js` against a local Chrome to confirm:

- daemon connects and can screenshot, click, navigate, type, scroll
- a dialog raised by a page is detected by `browser_page_info` and dismissed by `browser_handle_dialog`
- `browser_open_urls` opens 3 URLs in parallel and reports per-URL outcomes
- `browser_run_script` rejects a path outside `tmpdir()`/`cwd()`
- `browser_run_script` honors a 1-second timeout
- `BH_DEBUG_CLICKS=1 browser_click` produces an annotated screenshot
- `tsc --noEmit` passes with the new strict flags
