---
name: pi-browser-harness
description: Direct browser control via CDP. Use when the user wants to automate, scrape, test, or interact with web pages. Connects to the user's already-running Chrome.
---

# pi-browser-harness

Direct browser control via CDP. Gives pi agents full control of a real Chrome browser.
Browser tools coexist with all standard pi tools (read, bash, edit, write, etc.).

## Setup

Run `/browser-setup` to install browser-harness and connect to Chrome. Chrome must be running
with remote debugging enabled. Start Chrome with:

```
--remote-debugging-port=9222
```

Check status with `/browser-status`. Restart the daemon with `/browser-reload-daemon`.

## Core Workflow

```
browser_screenshot() → browser_click(x, y) → browser_screenshot()
```

1. **Screenshot first** — see what's on screen before any interaction
2. **Coordinate click** — read the target pixel from the screenshot, click at (x, y)
3. **Screenshot again** — verify the action worked

Compositor-level clicks (`Input.dispatchMouseEvent`) work through iframes, shadow DOM,
and cross-origin content. No selectors needed.

## Parallelization

**Always parallelize when possible.** Never sequence independent operations.

### What can run in parallel

- **Opening result pages:** Use `browser_open_urls` to open multiple URLs in parallel tabs
  instead of navigating one at a time. After opening, use `browser_list_tabs` to
  see the new tabs and `browser_switch_tab` to visit each one.

- **API calls:** `browser_http_get` calls are independent of browser state — fire
  multiple GETs in parallel to fetch APIs, static pages, or search results.

- **JS extraction across tabs:** Once tabs are loaded, extract data from each tab
  with `browser_execute_js` — these can run in parallel across different tabs.

- **Screenshots across tabs:** After opening multiple pages, capture screenshots
  of each tab in parallel. Each `browser_screenshot` targets the currently active
  tab, so switch tabs first, then screenshot.

- **Read + browser tools:** Use `read` and `browser_*` tools in the same turn —
  reading files or previous results is independent of browser actions.

### What must be sequential

- **Page interactions:** Clicks, typing, scrolling, and form submissions on the
  same page depend on prior state and must be sequential.

- **Tab switching then acting:** `browser_switch_tab` must complete before acting
  on the switched-to tab.

### Pattern: Parallel research across tabs

```
# Step 1: Open all result pages at once
browser_open_urls(["url1", "url2", "url3"])

# Step 2: Wait for them to load, then extract in parallel
browser_list_tabs()  # get targetIds

# Step 3: Extract data from each tab (parallel)
browser_switch_tab(targetId1) → browser_screenshot()   # These are sequential per tab
browser_switch_tab(targetId2) → browser_execute_js(...) # but you batch switch+act
```

### Pattern: Parallel API + browser

```
# Fire API calls while interacting with a page
browser_http_get("https://api.example.com/data")  # parallel
browser_click(x, y)                                 # parallel (different target)
browser_type("search term")                         # parallel (different target)
```

## Available Tools

### Navigation
- `browser_navigate` — navigate to a URL (creates new tab on first call, reuses current tab after)
- `browser_new_tab` — open a new tab, optionally navigate (use for first navigation)
- `browser_open_urls` — open multiple URLs in parallel tabs (use after search to open result links)
- `browser_go_back` / `browser_go_forward` / `browser_reload` — history navigation
- `browser_page_info` — get URL, title, viewport, scroll position, or dialog info
- `browser_list_tabs` / `browser_current_tab` / `browser_switch_tab` — tab management

### Interaction
- `browser_click` — click at viewport CSS-pixel coordinates
- `browser_type` — type text into focused element
- `browser_press_key` — press a key (Enter, Tab, Escape, arrows, etc.)
- `browser_scroll` — scroll the page at coordinates

### Visual
- `browser_screenshot` — capture PNG or JPEG screenshot (rendered inline in the TUI)

### Data Extraction
- `browser_execute_js` — execute JavaScript and return result
- `browser_http_get` — direct HTTP GET outside browser (10-50x faster for APIs)

### Utility
- `browser_wait` — wait N seconds
- `browser_wait_for_load` — wait for document.readyState === 'complete'
- `browser_handle_dialog` — accept or dismiss JS dialogs (alert/confirm/prompt)

### Extending
- `browser_run_script` — execute a temporary script file with daemon access

## Pattern Reference

### Navigation
```
browser_new_tab("https://example.com") → browser_wait_for_load() → browser_screenshot()
```

### Form Filling
```
browser_screenshot() → find input coordinates
→ browser_click(x, y) → browser_type("text")
→ browser_press_key("Tab") → browser_screenshot()
```

### Data Extraction
```
browser_execute_js("document.querySelector('.price').innerText")
// or for APIs directly:
browser_http_get("https://api.example.com/data")
```

### Scrolling
```
browser_screenshot() → browser_scroll({ deltaY: -500 }) → browser_screenshot()
```

### Research (search engine + browser_open_urls)
```
browser_new_tab("https://google.com/search?q=query") → search engine results
browser_open_urls({urls: ["url1", "url2"]}) → open result pages in parallel tabs
browser_list_tabs() → see all open tabs with targetIds
browser_switch_tab({targetId: "..."}) → switch to a specific tab
browser_wait_for_load() → wait for the page to render
browser_screenshot() → visually inspect the page
browser_execute_js("document.querySelector('.content').innerText") → extract text
```

## Temporary Scripts

When the built-in tools aren't enough, write a temporary script to disk and execute it
with `browser_run_script`. Scripts run in the harness process with direct access to
the browser daemon and full Node.js APIs — no dynamic tool registration needed.

```
  ● agent: needs to scrape 47 paginated search result pages
  │
  ● write("/tmp/scrape-pages.js", "...script using daemon.cdp() and daemon.evaluateJS()...")
  │
  ● browser_run_script("/tmp/scrape-pages.js", { urls: [...] })
  │
  ✓ script executes and returns results
```

The script is written to disk, so it's auditable and re-runnable.

**When to use scripts:**
- You're about to do the same 3+ step sequence more than once
- You need a capability the built-in tools don't provide (e.g., bulk CSV export, structured extraction, pagination)
- You discover a domain-specific pattern that should be reusable
- The alternative is a fragile multi-turn loop of screenshots + clicks

**What NOT to do:**
- Don't write scripts for one-off actions — use the built-in browser_* tools directly.
- Don't try to call browser_* tools from within a script — sequence them as separate tool calls.

**Script bindings:**
- `params` — the arguments passed to browser_run_script
- `daemon` — browser daemon with these methods:
  - `daemon.evaluateJs(expression)` — run JS in the current page
  - `daemon.pageInfo()` — get current page info or dialog
  - `daemon.listTabs()` — returns `{ success, data: [{ targetId, url, title }] }`
  - `daemon.switchTab(targetId)` — switch to a tab by full targetId
  - `daemon.newTab(url?)` — open and switch to a new tab
  - `daemon.current()` — returns `{ targetId, url?, title? }`
  - `daemon.session(targetId)` — returns a session object for raw CDP:
    - `session.call(method, params?)` — CDP command on the page target
    - `session.callOnTarget(method, params, sessionId)` — CDP on a specific session
    - `session.callBrowser(method, params?)` — CDP on the browser target
    - `session.takeDialog()` — get/dismiss pending dialog
- `require` — Node.js require() (use 'fs', 'path', 'crypto', etc.)
- `signal` — AbortSignal for cancellation
- `onUpdate` — progress callback: onUpdate({ content: [{ type: 'text', text: '...' }] })
- `ctx` — ExtensionContext (ctx.cwd, ctx.signal, etc.)
- `console`, `fetch`, `JSON`, `Buffer`, `setTimeout`, `clearTimeout`

**Example — a script that extracts structured data:**
```javascript
// /tmp/extract-products.js
const info = await daemon.pageInfo();
if (info && "dialog" in info) throw new Error("Dialog is blocking: " + info.dialog.message);
const data = await daemon.evaluateJs(`
  JSON.stringify(Array.from(document.querySelectorAll('${params.rowSelector}')).map(el => ({
    title: el.querySelector('${params.titleSelector}')?.textContent?.trim(),
    price: el.querySelector('${params.priceSelector}')?.textContent?.trim(),
  })))
`);
return { content: [{ type: 'text', text: data }], details: { raw: JSON.parse(data) } };
```

## What NOT To Do

- **Don't launch your own browser** — you're connected to the user's real Chrome
- **Don't type credentials** — if you hit an auth wall, stop and ask the user
- **Don't assume page state** — screenshot to confirm
- **Don't write pixel coordinates into documentation** — describe how to locate targets (selectors, text, aria-label)
- **Don't use browser_navigate for first navigation** — use browser_new_tab to explicitly preserve the user's active tab (browser_navigate auto-creates a new tab on first call, but explicit is clearer)
- **Don't ignore dialogs** — if browser_page_info returns a dialog, handle it first

## Dialogs

JS dialogs (alert, confirm, prompt, beforeunload) freeze the page's JS thread.
If browser_page_info returns a dialog, handle it with browser_handle_dialog
before any other browser action.

```
// Check page_info first — if it shows a dialog:
browser_handle_dialog({ action: "accept" })       // accept/confirm
browser_handle_dialog({ action: "dismiss" })       // dismiss/cancel
browser_handle_dialog({ action: "accept", promptText: "hello" })  // prompt with text
```

## SPAs (React, Vue, etc.)

`browser_wait_for_load()` only checks `document.readyState === "complete"`.
Single-page apps often paint content after this. After wait_for_load, use
`browser_execute_js` to check for specific elements:

```
browser_execute_js("!!document.querySelector('.loaded-content')")
```

## Keyboard Modifiers

`browser_press_key` supports modifier bitfield:
- 1 = Alt, 2 = Ctrl, 4 = Meta/Cmd, 8 = Shift
- Combine: Ctrl+Shift = 2|8 = 10, Cmd+Shift = 4|8 = 12

## Troubleshooting

- **Daemon not starting**: Run `/browser-setup` to re-run the guided setup
- **"DevToolsActivePort not found"**: Open chrome://inspect/#remote-debugging, tick checkbox, click Allow
- **Stale session**: Run `/browser-reload-daemon` to restart the daemon
- **Dialog blocking**: Run browser_page_info to detect it, then browser_handle_dialog
- **Status check**: Run `/browser-status` to see daemon health and current page
- **Screenshot maxDim not working**: Install sharp (`npm install sharp`) for auto-resize support
- **Google navigation fails**: Google's anti-bot detection may reject CDP navigation; use `browser_http_get` to fetch search results instead

## Architecture

```
pi agent → pi-browser-harness (TypeScript)
               │ CDP WebSocket
               ▼
            Chrome

Temporary scripts:
  write("/tmp/script.js") → browser_run_script("/tmp/script.js")
      │                              │
      ▼                              ▼
  script on disk (auditable)    executed in harness process with daemon access
```
