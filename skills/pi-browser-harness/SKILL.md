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
  ├─ A page requires custom request headers?
  │     → create/select owned tab → browser_set_headers → navigate/interact → browser_clear_headers
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

`browser_web_search` and `browser_read_page` each run in their own isolated tab and never touch the user's current tab. Pair them for a research question: search for candidate URLs, then read the promising ones.

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

## Browser profile

Every harness tab opens in one chosen browser profile, which determines the logins,
cookies, and extensions you're working with. The user picks it once via
`/browser-profile`; the choice persists across sessions in `~/.pi/agent/`.

The first `browser_setup` in a fresh install shows that picker, so the tool may pause
briefly on user input — this is expected, and the result appears in the tool output as
`Browser profile: <name> (<email>)`.

If setup reports `couldn't open a window in "…" automatically`, the harness could not
open the pinned profile's window. Tell the user to open that profile from their browser's
profile menu and retry, or to run `/browser-profile` to choose another. Never work around
it by opening tabs elsewhere — a different profile means different accounts.

## Connection

You're attached to the user's real Chrome — never launch your own. If auth is required, stop and ask the user. If `browser_page_info` returns a dialog, handle it first with `browser_handle_dialog`.

## Downloads land in the user's context

`browser_download` calls `Browser.setDownloadBehavior` with no `browserContextId`, which Chrome applies to its **default browser context** — the same one the user's own tabs are in. So the override redirects the user's manual downloads too, and it lives in Chrome rather than in this session: it survives the tab, the client and the daemon. Symptom the user reports: *"I download things in Chrome and nothing appears in Downloads."*

Confirm it from Chrome's history rather than guessing. Substitute the profile directory the harness is pinned to (see `~/.pi/agent/browser-harness.json`; `Default` covers the common case, quote names containing spaces):

```bash
HIST="$HOME/Library/Application Support/Google/Chrome/Default/History"   # Linux: ~/.config/google-chrome/Default/History
sqlite3 "$HIST" "select datetime(start_time/1000000-11644473600,'unixepoch','localtime') t,
  case state when 1 then 'complete' when 0 then 'in progress' else 'other' end,
  target_path from downloads order by start_time desc limit 15;"
```

Complete rows pointing at `/tmp/...` instead of `~/Downloads` are the override, not a macOS permission problem. It is undone at session shutdown; to undo it sooner call `browser_download({ restore: true })`, or send `Browser.setDownloadBehavior {behavior:"default"}` if the running harness predates that flag. Call `restore: true` as soon as you are done with a download path.

`browser_run_script` is the same hazard: it runs in the harness process, so a script that sets download behavior and then throws partway leaves Chrome mutated. Reset it in a `finally`, not after the last line.

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
