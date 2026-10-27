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

## Tool reference

Every tool, its concurrency lane, and a one-line summary. `serialized` tools queue through one
shared mutation lane; `parallel` tools may run alongside them. The decision tree above says which
to reach for first; the tool descriptions and parameter schemas carry per-tool detail.

<!-- tools:start -->
Generated from `src/registry.ts` by `npm run gen:skill`; do not edit by hand.

| Tool | Lane | Summary |
|---|---|---|
| `browser_clear_headers` | serialized | Clear extra request headers from the current owned tab |
| `browser_click` | serialized | Click an element by ref (preferred) or pixel coordinates |
| `browser_close_tab` | serialized | Close an owned tab |
| `browser_console` | parallel | Read JS errors / console output on the current tab |
| `browser_current_tab` | parallel | Get current tab info |
| `browser_dispatch_key` | serialized | Dispatch a DOM KeyboardEvent on an element by ref (preferred) or selector |
| `browser_download` | serialized | Configure download directory |
| `browser_drag_and_drop` | serialized | Drag and drop between two coordinates |
| `browser_execute_js` | parallel | Execute JS in the page — surgical DOM reads (preferred over screenshot) |
| `browser_fill` | serialized | Fill a form field by ref (preferred) or selector (works with React/Vue controlled inputs) |
| `browser_fill_form` | serialized | Fill many form fields at once by ref — React-safe, self-confirming |
| `browser_focus` | serialized | Focus an element by ref (preferred) or selector |
| `browser_go_back` | serialized | Go back one page |
| `browser_go_forward` | serialized | Go forward one page |
| `browser_handle_dialog` | serialized | Accept or dismiss a JS dialog |
| `browser_http_get` | parallel | HTTP GET (outside browser; for APIs/static pages) |
| `browser_list_tabs` | parallel | List browser tabs |
| `browser_navigate` | serialized | Navigate to a URL |
| `browser_network_requests` | parallel | Inspect recent network requests on the current page |
| `browser_new_tab` | serialized | Open a new tab |
| `browser_open_urls` | serialized | Open multiple URLs in new tabs (parallel) |
| `browser_page_info` | parallel | Get current page URL, title, viewport, and scroll position |
| `browser_press_key` | serialized | Press a key (Enter, Tab, Escape, arrows, or any character) |
| `browser_print_to_pdf` | serialized | Print the current page to PDF |
| `browser_read_page` | parallel | Read a page's main content as clean text |
| `browser_reload` | serialized | Reload the page |
| `browser_run_script` | parallel | Run a temporary script with daemon + Node access (security-bounded) |
| `browser_save_recipe` | parallel | Save the last browser task as a replayable recipe |
| `browser_screenshot` | parallel | Capture a screenshot — visual verification only |
| `browser_scroll` | serialized | Scroll the page (deltaY positive=down, negative=up) |
| `browser_select_option` | serialized | Select an option in a native <select> by ref (preferred) or selector |
| `browser_set_checked` | serialized | Set a checkbox/radio checked state by ref |
| `browser_set_headers` | serialized | Set extra request headers on the current owned tab |
| `browser_setup` | parallel | Initialize browser connection |
| `browser_snapshot` | parallel | Get accessibility-tree snapshot with stable element refs (default for page inspection) |
| `browser_switch_tab` | serialized | Switch tabs |
| `browser_type` | serialized | Type text into the focused element |
| `browser_upload_file` | serialized | Upload a file to a file input by ref (preferred) or selector |
| `browser_viewport_resize` | serialized | Resize the viewport (responsive testing) |
| `browser_wait` | parallel | Wait N seconds |
| `browser_wait_for` | parallel | Wait for an element or text to appear (or an element to disappear) |
| `browser_wait_for_load` | serialized | Wait for the page to finish loading |
| `browser_web_search` | serialized | Search the web for a query |
<!-- tools:end -->

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

`browser_download` calls `Browser.setDownloadBehavior` with no `browserContextId`, which Chrome applies to its **default browser context** — the same one the user's own tabs are in. The override redirects the user's manual downloads too, and it lives on the browser connection the daemon keeps open, so it outlives the tab and the pi session. Symptom the user reports: *"I download things in Chrome and nothing appears in Downloads."*

A clean session shutdown restores the default; a killed session does not. Call `browser_download({ restore: true })` as soon as you are done with a download path, and if a user reports the symptom, call it first.

`browser_run_script` is the same hazard: a script that sets download behavior and then throws partway leaves Chrome mutated. Reset it in a `finally`, not after the last line.

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

## Troubleshooting: "Could not start the browser daemon"

`browser_setup` spawns the daemon as `node <tsx cli> <pkg>/src/daemon/main.ts` with `stdio: "ignore"` (tsx is resolved from the package directory upward, so in pi's hoisted install it sits beside the package rather than inside it). A crash before the socket binds is completely silent and all you see is `Could not start the browser daemon. Check /tmp/pi-browser-daemon.sock.`

Run it in the foreground to see the real error (it prints whether it reached Chrome):

    cd <pkg> && node "$(node -p "require.resolve('tsx/cli')")" src/daemon/main.ts

Known cause (package 0.11.1): `Error: Cannot find module 'typebox'` at `src/cdp/discovery.ts`. The package declares `typebox` in `peerDependencies` and `devDependencies`, and pi installs packages with dev and peer dependencies omitted, so the tree has no physical copy. It still resolves inside the pi extension host, which maps `typebox` to pi's bundled copy, but not in the spawned daemon process, which resolves modules from the package directory upward. The daemon dies, no socket appears, and every browser tool reports `not_connected`.

Fix it without touching the manifest, which must keep `typebox` out of `dependencies` (pi warns on it and `npm run check` rejects it):

    cd <pkg> && npm install --no-save typebox --no-audit --no-fund

or restore the full tree with `npm ci`, which installs the `devDependencies` copy. Then confirm with `node -e "console.log(require.resolve('typebox'))"` inside the package directory, and start the daemon with `NODE_PATH` unset to prove no environment workaround is in play. A fresh clone or update reinstalls the tree, so the missing copy can come back; the manifest itself is correct upstream.

Do not work around it with `npm install typebox --save` (that writes `typebox` into `dependencies`, tripping pi's extension warning and the manifest check), a global `NODE_PATH`, or a hand-made symlink: the spawn inherits the extension host environment, so a shell-level export may not reach it, and the underlying problem is an incomplete install, not an undeclared dependency.
