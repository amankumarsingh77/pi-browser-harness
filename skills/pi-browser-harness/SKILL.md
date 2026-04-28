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
- `browser_screenshot` — capture PNG screenshot

### Data Extraction
- `browser_execute_js` — execute JavaScript and return result
- `browser_http_get` — direct HTTP GET outside browser (10-50x faster for APIs)

### Utility
- `browser_wait` — wait N seconds
- `browser_wait_for_load` — wait for document.readyState === 'complete'
- `browser_handle_dialog` — accept or dismiss JS dialogs (alert/confirm/prompt)

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

## Self-Extending Harness

The harness can write its own tools when you need a capability that doesn't exist yet.
This is the same philosophy as browser-harness: "The agent writes what's missing, mid-task."

```
  ● agent: needs to scrape 47 paginated search result pages
  │
  ● calls list_dynamic_tools() → empty
  │
  ● calls register_tool({ name: "scrape_paginated", implementation: "..." })
  │
  ✓ next turn: scrape_paginated() is available and callable
```

**Tool lifecycle:**
- `list_dynamic_tools` — see what's already been registered
- `register_tool` — inject a new tool (available next turn, no reload)
- `remove_tool` — retire a tool you no longer need

**When to extend:**
- You're about to do the same 3+ step sequence more than once
- You need a capability the built-in tools don't provide (e.g., bulk CSV export, structured extraction, pagination)
- You discover a domain-specific pattern that should be reusable
- The alternative is a fragile multi-turn loop of screenshots + clicks

**What NOT to do with dynamic tools:**
- Don't register tools for one-off actions. Use the built-in browser_* tools directly.
- Don't duplicate existing tools. Call list_dynamic_tools first.
- Don't try to call browser_* tools from within a dynamic tool implementation. Sequence them as separate tool calls.

**Implementation bindings available inside dynamic tools:**
- `params` — the tool's arguments object
- `daemon` — browser daemon (daemon.cdp(), daemon.evaluateJS(), daemon.getPageInfo(), etc.)
- `require` — Node.js require() (use 'node:fs/promises', 'node:path', 'node:crypto', etc.)
- `signal` — AbortSignal for cancellation
- `onUpdate` — progress callback: onUpdate({ content: [{ type: 'text', text: '...' }] })
- `ctx` — ExtensionContext (ctx.cwd, ctx.signal, etc.)
- `console`, `fetch`, `JSON`, `Buffer`, `setTimeout`, `clearTimeout`

**Example — a dynamic tool that extracts structured data:**
```javascript
// register_tool implementation:
const info = await daemon.getPageInfo();
if ("dialog" in info) throw new Error("Dialog is blocking: " + info.dialog.message);
const data = await daemon.evaluateJS(`
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

## Architecture

```
pi agent → pi-browser-harness (TypeScript)
               │ Unix socket
               ▼
        /tmp/bu-<namespace>.sock
               │
               ▼
        daemon.py → CDP WebSocket → Chrome

Dynamic tools (registered at runtime):
  list_dynamic_tools / register_tool / remove_tool
      │
      ▼
  pi.registerTool() → available next turn, no reload
```
