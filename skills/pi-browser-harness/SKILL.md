---
name: pi-browser-harness
description: Direct browser control via CDP. Use when the user wants to automate, scrape, test, or interact with web pages. Connects to the user&apos;s already-running Chrome. Default to browser_snapshot for understanding pages and browser_execute_js for surgical reads — browser_screenshot is for visual verification only.
---

# pi-browser-harness

Direct browser control of the user's running Chrome via CDP.

## Tool hierarchy

```
What do you need to know?

  ├─ Page structure / what's clickable / labels?
  │     → browser_snapshot     (DEFAULT — AX tree with @(x,y) per interactive element)
  │
  ├─ A specific element's value / attribute / coords?
  │     → browser_execute_js   (e.g. el.innerText, el.getBoundingClientRect())
  │
  ├─ Network behavior on the current page?
  │     → browser_network_requests
  │
  ├─ Find pages on the web about a topic?
  │     → browser_web_search    (ranked SERP — links only; follow up with browser_read_page)
  │
  ├─ An article's main content as clean text?
  │     → browser_read_page     (reader mode — a url or an owned targetId → boilerplate stripped)
  │
  ├─ JS errors / why did nothing happen after an action?
  │     → browser_console     (DIAGNOSTIC — only when something looks broken)
  │
  └─ Visual rendering (layout / colors / chart drew correctly)?
        → browser_screenshot   (LAST RESORT — pixels only)
```

Pass `@(x,y)` from `browser_snapshot` straight to `browser_click`. No screenshot round-trip.

`browser_web_search` and `browser_read_page` each run in their own isolated tab and never touch the user's current tab. For a multi-source question that needs a synthesized, cited report, use the **deep-research** skill (or `/deep-research <question>`): it fans out isolated `web-search-researcher` subagents over both tools and writes a source-cited Markdown report.

## Connection Setup

Browser control is **on-demand** — the daemon does NOT start automatically.
If you try a browser tool and get a `not_connected` error, tell the user to
run `/browser-setup` first. This opens the daemon and connects to Chrome.
Once initialized, all subsequent sessions reuse the same connection silently.

**Before calling any browser tool**, the runtime checks for the daemon socket
at `/tmp/pi-browser-daemon.sock`. If the socket is missing (user hasn't run
`/browser-setup`), you get: `"Browser harness not initialized. Run /browser-setup first"`.

**Do not ask the user.** Call `browser_setup` directly — it spawns the daemon,
connects to Chrome, and opens a test tab. The user sees a single "Allow Remote
Debugging" prompt the first time. After that, all sessions reuse the same connection.
`browser_setup` is idempotent — safe to call even when already connected.

## Connection

You're attached to the user's real Chrome — never launch your own. If auth is required, stop and ask the user. If `browser_page_info` returns a dialog, handle it first with `browser_handle_dialog`.

## Diagnosing a "nothing happened" moment

When an action runs but the page didn't change, capture `browser_console`'s `nextCursor` *before* the action, take the action, then call `browser_console({ sinceSeq: <cursor> })` after — this isolates what your action caused from what was already there. Pair with `browser_network_requests({ sinceMs: 5000 })` to see if an API call fired and failed. The console buffer is page-scoped: it clears on tab switch, capacity 500.

## Temporary scripts

When a workflow repeats 3+ times or needs Node.js APIs, write a script to disk and run it with `browser_run_script`. Scripts get a `daemon` binding for direct CDP access — much faster than chaining tool calls.

**Bindings inside a script:**

- `params` — args passed to `browser_run_script`
- `daemon`:
  - `daemon.evaluateJs(expression)` — run JS in the current page
  - `daemon.pageInfo()` — `{ url, title, ... }` or `{ dialog }`
  - `daemon.listTabs()` / `daemon.switchTab(targetId)` / `daemon.newTab(url?)` / `daemon.current()`
  - `daemon.session(targetId)` for raw CDP: `session.call`, `session.callOnTarget`, `session.callBrowser`, `session.takeDialog`
- `require`, `fetch`, `JSON`, `Buffer`, `console`, `setTimeout`, `clearTimeout`
- `signal` — AbortSignal
- `onUpdate({ content: [{ type: 'text', text }] })` — progress callback
- `ctx` — `ExtensionContext`

**Don't:**
- Use scripts for one-off actions — call `browser_*` tools directly.
- Call `browser_*` tools from inside a script — sequence them as separate tool calls outside.
