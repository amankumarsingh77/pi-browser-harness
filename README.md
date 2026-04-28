# pi-browser-harness

> **Full browser control for pi agents.** Navigate, click, type, screenshot, and extract data from a real Chrome browser — all through CDP, all from your coding agent.

<p align="center">
  <img alt="Version" src="https://img.shields.io/npm/v/@pi-browser-harness?style=flat-square&color=2563eb">
  <img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square">
  <img alt="Pi Package" src="https://img.shields.io/badge/pi-package-2563eb?style=flat-square">
  <img alt="Node" src="https://img.shields.io/badge/node-%3E%3D18-339933?style=flat-square&logo=node.js&logoColor=white">
</p>

**pi-browser-harness** gives pi agents full control of a real Chrome browser. No headless mode, no emulation — your agent sees what you see, clicks where you'd click, and reads pages exactly as they render. Browser tools coexist seamlessly with all standard pi tools (`read`, `bash`, `edit`, `write`).

---

## Why pi-browser-harness?

| | |
|---|---|
| 🖱️ **Real browser, real pixels** | Connects to your running Chrome via CDP. Compositor-level clicks work through iframes, shadow DOM, and cross-origin content. |
| 🧩 **Seamless pi integration** | `browser_*` tools appear alongside `read`, `bash`, `edit` — no context switching, no separate daemon management. |
| 🔧 **Self-extending harness** | The agent writes its own tools mid-task. Need a paginated scraper? Bulk CSV exporter? Register it at runtime, callable next turn. |
| ⚡ **Fast data extraction** | `browser_http_get` bypasses the browser entirely for APIs — 10-50x faster than DOM scraping. `browser_execute_js` for rendered data. |
| 🛡️ **Dialog-aware** | Auto-detects JS dialogs (alert, confirm, prompt, beforeunload) before they block your session. |
| 📸 **Visual feedback** | Screenshots before and after every action. The agent can see exactly what it's doing. |

---

## Quick Start

```bash
# 1. Install the package
pi install npm:pi-browser-harness

# 2. Start Chrome with remote debugging
# macOS:
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome --remote-debugging-port=9222 &

# Linux:
google-chrome --remote-debugging-port=9222 &

# 3. Run the guided setup inside pi
/browser-setup
```

**That's it.** Your pi agent now has 20 browser control tools. Try:

```
> navigate to https://github.com and take a screenshot
```

---

## Features

### 🧭 Navigation & Tabs

| Tool | What it does |
|------|-------------|
| `browser_navigate` | Navigate to a URL (safe: creates new tab on first call) |
| `browser_new_tab` | Open a new tab, optionally navigate |
| `browser_open_urls` | Open multiple URLs in parallel tabs (great after web search) |
| `browser_go_back` / `browser_go_forward` | History navigation |
| `browser_reload` | Reload the current page |
| `browser_page_info` | Get URL, title, viewport, scroll position, or detect JS dialogs |
| `browser_list_tabs` / `browser_current_tab` | Tab discovery and identification |
| `browser_switch_tab` | Switch to a specific tab by targetId |

### 🖱️ Interaction

| Tool | What it does |
|------|-------------|
| `browser_click` | Click at viewport CSS-pixel coordinates (compositor-level) |
| `browser_type` | Type text into the focused element |
| `browser_press_key` | Press any key with modifier support (Ctrl, Alt, Meta, Shift) |
| `browser_scroll` | Scroll the page by delta pixels |
| `browser_handle_dialog` | Accept or dismiss JS dialogs |

### 📸 Visual & Data

| Tool | What it does |
|------|-------------|
| `browser_screenshot` | Capture a PNG screenshot of the current page |
| `browser_execute_js` | Execute JavaScript and return the result |
| `browser_http_get` | Direct HTTP GET (bypasses browser — 10-50x faster for APIs) |
| `browser_wait` | Wait N seconds |
| `browser_wait_for_load` | Wait for `document.readyState === 'complete'` |

### 🔧 Self-Extending Harness

| Tool | What it does |
|------|-------------|
| `list_dynamic_tools` | See what's already been registered |
| `register_tool` | Inject a new tool (available immediately, next turn) |
| `remove_tool` | Retire a tool that's no longer needed |

> **Philosophy:** "The agent writes what's missing, mid-task." When the built-in tools aren't enough, the agent extends the harness itself — no reload, no restart.

---

## Installation

### Prerequisites

| Requirement | Version | Notes |
|------------|---------|-------|
| **pi** | Latest | The pi coding agent CLI |
| **Node.js** | ≥ 18 | Runtime for the extension |
| **Chrome / Chromium / Edge** | Any recent | Must support CDP (Chrome DevTools Protocol) |
| **browser-harness daemon** | Latest | Installed automatically by `/browser-setup` |
| **uv** (optional) | Latest | Python package manager; used for daemon installation |
| **git** (optional) | Any | Fallback installation method |

### Installing the package

```bash
# From npm (recommended)
pi install npm:pi-browser-harness

# From git
pi install git:github.com/browser-use/browser-harness

# Locally (for development)
pi install ./pi-browser-harness
```

### Installing the browser-harness daemon

The daemon (`daemon.py`) is what connects pi-browser-harness to Chrome. Run the guided setup:

```
/browser-setup
```

This will:
1. Check for an existing browser-harness installation
2. Auto-install via `uv tool install browser-harness` or `git clone`
3. Verify Chrome is running with remote debugging
4. Start the daemon and test the connection

**Manual installation:**

```bash
# Option A: uv (recommended)
uv tool install browser-harness

# Option B: git clone
git clone https://github.com/browser-use/browser-harness ~/Developer/browser-harness
cd ~/Developer/browser-harness && uv sync
```

### Enabling Chrome Remote Debugging

Start Chrome with the `--remote-debugging-port` flag:

```bash
# macOS
/Applications/Google\ Chrome.app/Contents/MacOS/Google\ Chrome \
  --remote-debugging-port=9222

# Linux
google-chrome --remote-debugging-port=9222

# Windows
"C:\Program Files\Google\Chrome\Application\chrome.exe" --remote-debugging-port=9222
```

> **Edge / Chromium**: Works identically — just replace the binary path.

---

## Usage

### Core Workflow

The fundamental pattern: **screenshot → interact → screenshot → verify.**

```
browser_screenshot() → find the target → browser_click(x, y) → browser_screenshot()
```

Every interaction is verified visually. Never assume an action worked.

### Navigation

```bash
# First navigation: creates a new tab (preserves user's active tab)
browser_navigate("https://github.com/browser-use/browser-harness")
browser_wait_for_load()
browser_screenshot()
```

### Form Filling

```bash
browser_screenshot()                          # See the form
browser_click(400, 200)                       # Click the search input
browser_type("pi browser harness")            # Type the query
browser_press_key("Enter")                    # Submit
browser_wait_for_load()
browser_screenshot()                          # Verify results
```

### Data Extraction

```bash
# Fast: Direct HTTP for APIs
browser_http_get("https://api.github.com/repos/browser-use/browser-harness")

# DOM scraping: Execute JS in the rendered page
browser_execute_js("document.querySelector('.price').innerText")

# Structured: Extract arrays of data
browser_execute_js(`
  JSON.stringify(
    Array.from(document.querySelectorAll('.result')).map(el => ({
      title: el.querySelector('h3')?.textContent,
      link: el.querySelector('a')?.href,
    }))
  )
`)
```

### Research Workflow (Search + Tabs)

```bash
# Step 1: Search
browser_navigate("https://google.com/search?q=chrome+devtools+protocol+reference")

# Step 2: Open result links in parallel tabs
browser_open_urls({ urls: [
  "https://chromedevtools.github.io/devtools-protocol/",
  "https://developer.chrome.com/docs/devtools",
] })

# Step 3: List all tabs to get target IDs
browser_list_tabs()

# Step 4: Switch to the tab you want
browser_switch_tab({ targetId: "ABC123..." })

# Step 5: Inspect
browser_wait_for_load()
browser_screenshot()
browser_execute_js("document.querySelector('.main-content').innerText")
```

### SPAs (React, Vue, etc.)

`browser_wait_for_load()` only checks `document.readyState === 'complete'`. SPAs often render content after this. Check for specific elements:

```bash
browser_navigate("https://my-spa.example.com")
browser_wait_for_load()

# Poll for the element to appear
browser_execute_js("!!document.querySelector('.loaded-content')")
```

### Keyboard Modifiers

`browser_press_key` supports modifier bitfield combinations:

| Combo | Bitfield | Example |
|-------|----------|---------|
| Ctrl+C | 2 | `browser_press_key("c", { modifiers: 2 })` |
| Cmd+V | 4 | `browser_press_key("v", { modifiers: 4 })` |
| Ctrl+Shift+T | 10 (2\|8) | `browser_press_key("T", { modifiers: 10 })` |
| Cmd+Shift+N | 12 (4\|8) | `browser_press_key("N", { modifiers: 12 })` |

---

## Self-Extending Harness

When the built-in tools aren't enough, the agent writes its own:

```
  ● agent: needs to scrape 47 paginated search result pages
  │
  ● calls list_dynamic_tools() → empty
  │
  ● calls register_tool({
  │     name: "scrape_paginated",
  │     implementation: "..."
  │   })
  │
  ✓ next turn: scrape_paginated() is available and callable
```

### Tool Lifecycle

1. **`list_dynamic_tools`** — Check what's already registered
2. **`register_tool`** — Inject a new tool with custom JavaScript
3. **`remove_tool`** — Retire a tool you no longer need

### Dynamic Tool Bindings

Tools receive these bindings at runtime:

| Binding | Description |
|---------|-------------|
| `params` | Tool arguments (as passed by the caller) |
| `daemon` | Browser daemon — `daemon.cdp()`, `daemon.evaluateJS()`, `daemon.getPageInfo()` |
| `require` | Node.js `require()` for builtins and installed packages |
| `signal` | `AbortSignal` for cancellation |
| `onUpdate` | Progress callback: `onUpdate({ content: [{ type: 'text', text: '...' }] })` |
| `ctx` | `ExtensionContext` with `cwd`, `sessionManager`, `ui`, `signal` |
| `console`, `fetch`, `JSON`, `Buffer`, `setTimeout`, `clearTimeout` | Standard globals |

### Example: Structured Data Extractor

```javascript
// register_tool implementation:
const info = await daemon.getPageInfo();
if ("dialog" in info) throw new Error("Dialog is blocking: " + info.dialog.message);

const data = await daemon.evaluateJS(`
  JSON.stringify(
    Array.from(document.querySelectorAll('${params.rowSelector}')).map(el => ({
      title: el.querySelector('${params.titleSelector}')?.textContent?.trim(),
      price: el.querySelector('${params.priceSelector}')?.textContent?.trim(),
      link: el.querySelector('a')?.href,
    }))
  )
`);

const parsed = JSON.parse(data);
return {
  content: [{ type: 'text', text: `Extracted ${parsed.length} items:\n\n${JSON.stringify(parsed, null, 2)}` }],
  details: { items: parsed, count: parsed.length }
};
```

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│  pi agent                                       │
│    │                                             │
│    ├─ browser_navigate()                         │
│    ├─ browser_screenshot()                       │
│    ├─ browser_click(x, y)                        │
│    ├─ browser_execute_js(...)                    │
│    ├─ list_dynamic_tools()                       │
│    ├─ register_tool(...)                         │
│    └─ remove_tool(...)                           │
│                                                  │
│    pi-browser-harness (TypeScript extension)     │
└────────────────────┬────────────────────────────┘
                     │ Unix socket
                     │ /tmp/bu-<namespace>.sock
                     ▼
            ┌────────────────┐
            │  daemon.py     │
            │  (Python)      │
            └───────┬────────┘
                    │ CDP WebSocket
                    │ ws://localhost:9222
                    ▼
            ┌────────────────┐
            │  Chrome / Edge │
            │  (user's real  │
            │   browser)     │
            └────────────────┘
```

### Data Flow

1. **pi agent** calls a `browser_*` tool (e.g., `browser_screenshot()`)
2. **pi-browser-harness extension** translates the call into a CDP command
3. **JSON-line request** sent over Unix socket to `daemon.py`
4. **daemon.py** relays the command over CDP WebSocket to Chrome
5. **Chrome** executes the command and returns the result
6. Result flows back through the chain to the agent

### Session Persistence

- Tab history, daemon namespace, and preferences persist across session reloads and branch navigation
- State is stored via `pi.appendEntry()` in the session's JSONL file
- On `session_start`, state is restored by scanning the branch for the last `browser-harness-state` entry

### Key Design Decisions

- **One socket connection per request** — stateless, matches the daemon's internal `_send` pattern
- **Session auto-recovery** — stale CDP sessions are automatically re-attached
- **Compositor-level clicks** — `Input.dispatchMouseEvent` works through iframes, shadow DOM, and cross-origin content without selectors
- **Daemon auto-restart** — if the daemon socket dies mid-request, it's restarted and the request is retried once

---

## Configuration

### CLI Flags

| Flag | Type | Default | Description |
|------|------|---------|-------------|
| `--browser-namespace` | `string` | auto-generated | Daemon namespace (`BU_NAME`). Use to run multiple instances. |
| `--browser-debug-clicks` | `boolean` | `false` | Enable debug click overlay (saves annotated screenshots to `/tmp`). |

### Commands

| Command | Description |
|---------|-------------|
| `/browser-setup` | Guided setup wizard — installs browser-harness, connects to Chrome |
| `/browser-status` | Show daemon health, current page URL/title/viewport |
| `/browser-reload-daemon` | Restart the browser daemon |

---

## Troubleshooting

| Symptom | Likely Cause | Fix |
|---------|-------------|-----|
| Daemon not starting | Chrome remote debugging not enabled | Start Chrome with `--remote-debugging-port=9222` |
| "DevToolsActivePort not found" | Chrome didn't accept the debugging connection | Open `chrome://inspect/#remote-debugging`, tick the checkbox, click Allow |
| Daemon starts but no tools work | Stale or dead CDP session | Run `/browser-reload-daemon` to restart |
| Dialog blocking page | JS `alert`/`confirm`/`prompt` is open | Run `browser_page_info()` to detect it, then `browser_handle_dialog()` |
| Page not fully loaded | SPA with async rendering | After `browser_wait_for_load()`, use `browser_execute_js()` to check for specific elements |
| `uv` not found | Python package manager not installed | Install via `curl -LsSf https://astral.sh/uv/install.sh \| sh` or use the git fallback |
| Socket permission denied | Stale socket file from previous run | `rm /tmp/bu-*.sock /tmp/bu-*.pid` and restart |
| Windows: `ps` not found | `setup.ts` uses Unix commands | Windows detection is best-effort; see manual installation steps above |

---

## Security

> **Warning:** This extension gives your pi agent full control over your real Chrome browser. It can see your open tabs, read page content, submit forms, and interact with authenticated sessions.

- **No sandboxing** — the agent has access to whatever Chrome has access to
- **Credentials** — if the agent hits an auth wall, it should stop and ask you. Never store credentials in agent prompts.
- **Dynamic tools** — `register_tool` evaluates user-supplied JavaScript in the pi process with full `require` access. Review any dynamic tool implementations you didn't write yourself.
- **Data handling** — Screenshots are saved to `/tmp`. HTTP responses and JS evaluation results may contain sensitive page data.
- **Session persistence** — Tab history and daemon state are stored in pi's session file (`.jsonl`). These contain page URLs and titles.

---

## Contributing

We welcome contributions! Here's how to get started:

```bash
# Clone the repository
git clone https://github.com/browser-use/browser-harness
cd browser-harness/pi-browser-harness

# Install dependencies
npm install

# Type-check
npm run typecheck

# Test locally
pi install ./   # Install from local path
```

### Development Guidelines

- **TypeScript strict mode** — all code must pass `tsc --noEmit`
- **Error handling** — tools must catch errors and return `isError: true` with a descriptive message
- **Tool names** — use `snake_case` for consistency with pi conventions
- **Parameters** — use `typebox` schemas for all tool parameters
- **Prompt guidelines** — every tool must include `promptSnippet` and `promptGuidelines` for LLM context

### Project Structure

```
pi-browser-harness/
├── src/
│   ├── index.ts          # Extension entry point, lifecycle, flags, commands
│   ├── daemon.ts         # BrowserDaemon: spawns daemon.py, CDP transport
│   ├── tools.ts          # All browser_* tool registrations
│   ├── dynamic-tools.ts  # Self-extending harness (register_tool, etc.)
│   ├── protocol.ts       # Unix socket protocol types and low-level transport
│   ├── prompt.ts         # System prompt injection
│   ├── renderers.ts      # Custom TUI renderers
│   ├── setup.ts          # /browser-setup wizard
│   └── state.ts          # Session persistence
├── skills/
│   └── pi-browser-harness/
│       └── SKILL.md      # User-facing skill documentation
├── package.json
├── tsconfig.json
├── LICENSE
├── CHANGELOG.md
└── README.md
```

---

## Roadmap

- [ ] Windows-native setup wizard (remove `ps`/`grep` dependency)
- [ ] iframe-target evaluation support in `browser_execute_js`
- [ ] Remote browser support (connect to Chrome running on another machine)
- [ ] Screenshot annotations (click markers, element highlights)
- [ ] Performance benchmarks and CI test suite
- [ ] Configurable screenshot output directory
- [ ] Recording/playback of interaction sequences
- [ ] Better audio/video support for media-heavy pages

---

## License

MIT — see [LICENSE](LICENSE) for details.

---

<p align="center">
  <sub>Built with ❤️ for the pi ecosystem. Makes coding agents see the web.</sub>
</p>
