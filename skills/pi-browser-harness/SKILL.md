---
name: pi-browser-harness
description: Direct browser control via CDP. Use when the user wants to automate, scrape, test, or interact with web pages. Connects to the user's already-running Chrome. Default to browser_snapshot for understanding pages and browser_execute_js for surgical reads — browser_screenshot is for visual verification only.
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
  └─ Visual rendering (layout / colors / chart drew correctly)?
        → browser_screenshot   (LAST RESORT — pixels only)
```

Pass `@(x,y)` from `browser_snapshot` straight to `browser_click`. No screenshot round-trip.

## Connection

You're attached to the user's real Chrome — never launch your own. If auth is required, stop and ask the user. If `browser_page_info` returns a dialog, handle it first with `browser_handle_dialog`.

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
