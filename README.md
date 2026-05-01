# pi-browser-harness

Full browser control for pi agents. Navigate, click, type, screenshot, and extract data from your real Chrome — driven by your coding agent.

---

## Quick Start

```bash
# 1. Install
pi install npm:pi-browser-harness

# Or install from GitHub:
# pi install git:github.com/amankumarsingh77/pi-browser-harness

# 2. Enable Chrome remote debugging
#    Open chrome://inspect/#remote-debugging in Chrome,
#    tick the "Discover network targets" checkbox, click Allow.
#    No Chrome relaunch needed.

# 3. Connect pi to Chrome
/browser-setup
```

That's it. Try:

```
> navigate to https://github.com and take a screenshot
```

### Requirements

- pi (latest)
- Node.js ≥ 22
- Chrome / Chromium / Edge (any recent version)

> If `chrome://inspect/#remote-debugging` isn't available, you can launch Chrome with `--remote-debugging-port=9222` instead. The harness will find it either way.

---

## What you can do

### Navigation & tabs

| Tool | What it does |
|------|--------------|
| `browser_navigate` | Go to a URL (reuses the attached tab) |
| `browser_new_tab` | Open a new tab, optionally navigate |
| `browser_open_urls` | Open many URLs in parallel tabs |
| `browser_go_back` / `browser_go_forward` | History navigation |
| `browser_reload` | Reload the current page |
| `browser_list_tabs` / `browser_current_tab` | Discover tabs |
| `browser_switch_tab` | Switch the active tab |
| `browser_page_info` | URL, title, viewport, scroll, dialog state |

### Interaction

| Tool | What it does |
|------|--------------|
| `browser_click` | Click at viewport coordinates (works through iframes / shadow DOM) |
| `browser_type` | Type into the focused element |
| `browser_press_key` | Send a key with optional modifiers |
| `browser_scroll` | Scroll by delta pixels |
| `browser_handle_dialog` | Accept or dismiss `alert` / `confirm` / `prompt` |

### Visual & data

| Tool | What it does |
|------|--------------|
| `browser_screenshot` | Capture the current page as PNG |
| `browser_execute_js` | Run JS in the page and return the result |
| `browser_http_get` | Direct HTTP GET — bypasses the browser, much faster for APIs |
| `browser_wait` / `browser_wait_for_load` | Sleep, or wait for `readyState === 'complete'` |

### Extending the harness at runtime

| Tool | What it does |
|------|--------------|
| `browser_run_script` | Execute a temporary script file with daemon access |

---

## Usage

The core pattern is **screenshot → act → screenshot → verify.** Don't assume an action worked — look.

### Navigate and screenshot

```
browser_navigate("https://github.com/browser-use/browser-harness")
browser_wait_for_load()
browser_screenshot()
```

### Fill a form

```
browser_screenshot()                  # see the form
browser_click(400, 200)               # click the search input
browser_type("pi browser harness")    # type
browser_press_key("Enter")            # submit
browser_wait_for_load()
browser_screenshot()                  # verify
```

### Extract data

```js
// Fast: hit the API directly, no browser
browser_http_get("https://api.github.com/repos/browser-use/browser-harness")

// DOM scraping for rendered content
browser_execute_js("document.querySelector('.price').innerText")

// Structured arrays
browser_execute_js(`
  JSON.stringify(
    Array.from(document.querySelectorAll('.result')).map(el => ({
      title: el.querySelector('h3')?.textContent,
      link:  el.querySelector('a')?.href,
    }))
  )
`)
```

### Open multiple results in parallel

```
browser_navigate("https://google.com/search?q=chrome+devtools+protocol")
browser_open_urls({ urls: [
  "https://chromedevtools.github.io/devtools-protocol/",
  "https://developer.chrome.com/docs/devtools",
]})
browser_list_tabs()
browser_switch_tab({ targetId: "..." })
```

### SPAs

`browser_wait_for_load` only checks `readyState`. For React/Vue/etc., poll for the actual element you want:

```js
browser_execute_js("!!document.querySelector('.loaded-content')")
```

### Keyboard modifiers

`browser_press_key` takes a modifier bitfield: `Alt=1`, `Ctrl=2`, `Meta/Cmd=4`, `Shift=8`. Combine with `|`.

```
browser_press_key("c", { modifiers: 2 })   // Ctrl+C
browser_press_key("v", { modifiers: 4 })   // Cmd+V
browser_press_key("T", { modifiers: 10 })  // Ctrl+Shift+T
```

### Writing a temporary script

When the built-ins aren't enough, write a script to disk and run it with `browser_run_script`.

```js
// 1. Write the script to disk
write("/tmp/scrape-results.js", `
  const data = await daemon.evaluateJS(\`
    JSON.stringify(
      Array.from(document.querySelectorAll('${params.selector}'))
        .map(el => el.textContent.trim())
    )
  \`);
  return {
    content: [{ type: "text", text: data }],
    details: { items: JSON.parse(data) },
  };
`)

// 2. Execute it
browser_run_script("/tmp/scrape-results.js", { selector: ".result" })
```

Scripts receive `params`, `daemon`, `require`, `signal`, `onUpdate`, `ctx`, plus the standard JS globals. The script is on disk — auditable and re-runnable.

---

## Commands

| Command | Description |
|---------|-------------|
| `/browser-setup` | Connect pi to Chrome (run once) |
| `/browser-status` | Show daemon health and current page |
| `/browser-reload-daemon` | Restart the connection |

---

## Troubleshooting

| Symptom | Fix |
|---------|-----|
| `DevToolsActivePort not found` | Open `chrome://inspect/#remote-debugging`, tick the checkbox, click Allow, then retry. |
| Connection fails after Chrome restart | Run `/browser-reload-daemon`. |
| Page seems loaded but content is missing | SPA — `browser_wait_for_load` isn't enough. Poll with `browser_execute_js` for the element you need. |
| A JS dialog is blocking actions | `browser_page_info` will report the dialog. Use `browser_handle_dialog` to accept or dismiss. |

---

## Security

This extension drives your real Chrome. The agent can see open tabs, read page content, submit forms, and act inside authenticated sessions. `browser_run_script` evaluates JavaScript in the pi process with full `require` access — review any temporary scripts the agent writes to `/tmp/` before executing them.

---

## License

MIT — see [LICENSE](LICENSE).
