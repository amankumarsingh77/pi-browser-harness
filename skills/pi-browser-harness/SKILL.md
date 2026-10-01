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

## Diagnosing a "nothing happened" moment

When an action runs but the page didn't change, capture `browser_console`'s `nextCursor` *before* the action, take the action, then call `browser_console({ sinceSeq: <cursor> })` after — this isolates what your action caused from what was already there. Pair with `browser_network_requests({ sinceMs: 5000 })` to see if an API call fired and failed. The console buffer is page-scoped: it clears on tab switch, capacity 500.

## Site UI quirks (verified)

- **Outlook web rule wizard** (`outlook.cloud.microsoft/mail/options/mail/rules`): the condition and action dropdowns ignore real mouse clicks and even `element.click()`. Open the combobox with a click, then drive it with `browser_press_key` (ArrowDown/ArrowUp + Enter). Values are committed as chips and the input clears, so read the panel `innerText` to confirm; re-open the saved rule (More actions > Edit rule) to verify what actually persisted.
- The From/To condition value is a contact picker listing **address-book entries only** (typeahead filters that list, no free text). A service sender that is not in the address book cannot be selected, so identify it with a `Subject includes` condition instead.
- The "Run rule now" folder picker is single-select and click-to-deselect. A tree row's rect covers its nested children, so a click at the row's vertical centre can select a child folder instead. Click the top third of the intended row and confirm the selection: the selected tree item carries `fw1kkzr fjw68qt` in its className, unselected ones do not. Running a rule shows a client-side progress banner ("running (N%), Processing X of Y messages") that can take 10+ minutes on a large mailbox; poll the banner, do not navigate away.
- `browser_snapshot` truncates before the Outlook settings panel, so `browser_execute_js` against a known anchor element is the reliable way to read that pane.

## Downloads

`browser_download` calls `Browser.setDownloadBehavior` on the browser, not on a tab. The setting is global and survives the session, so a scratch directory set for one task keeps receiving every later download, including the user's own manual ones, until Chrome is restarted.

- Set a scratch path only while you need it, then reset: `browser_download({ downloadPath: "~/Downloads" })` expanded to an absolute path.
- To find where a download actually went, read Chrome's own record instead of guessing:
```sh
cp "$HOME/Library/Application Support/Google/Chrome/Default/History" "$TMPDIR/History"
sqlite3 "$TMPDIR/History" "select datetime(start_time/1000000-11644473600,'unixepoch','localtime'), target_path from downloads order by start_time desc limit 10;"
```
- `find /tmp ...` silently misses everything: `/tmp` is a symlink and `find` does not descend a symlink start point. Use `/private/tmp`.

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

`browser_setup` spawns the daemon as `node <pkg>/node_modules/tsx/dist/cli.mjs <pkg>/src/daemon/index.ts` with `stdio: "ignore"`, so a crash before the socket binds is completely silent and all you see is `Could not start the browser daemon. Check /tmp/pi-browser-daemon.sock.`

Run it in the foreground to see the real error (it prints whether it reached Chrome):

    cd <pkg> && node node_modules/tsx/dist/cli.mjs src/daemon/index.ts

Known cause, seen 2026-09-29, package 0.11.1: `Error: Cannot find module 'typebox'` at `src/cdp/discovery.ts`. The package declares `typebox` only as a `peerDependency`, so it resolves inside the pi extension host (whose flat tree carries it via `~/.pi/agent/npm/node_modules`, e.g. through pi-fabric) but not in the spawned child process, which resolves modules from the package directory upward. The daemon dies, no socket appears, and every browser tool reports `not_connected`.

Fix it by declaring the dependency for real, which is what the extension (not the host) needs in order to spawn the daemon:

    cd <pkg> && npm install typebox --save --no-audit --no-fund

Then confirm with `node -e "console.log(require.resolve('typebox'))"` inside the package directory, and start the daemon with `NODE_PATH` unset to prove no environment workaround is in play. Reinstalling or updating the package from git restores the peer-only declaration, so this fix belongs upstream in the package's `package.json`.

Do not work around it with a global `NODE_PATH` or a hand-made symlink: the spawn inherits the extension host environment, so a shell-level export may not reach it, and the underlying bug is an undeclared dependency.
