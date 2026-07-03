/**
 * System prompt guidance for browser usage.
 *
 * Injects a compact browser control reference into the pi system prompt.
 * Per-tool guidelines are injected via promptGuidelines on each tool registration.
 * This prompt provides only the cross-cutting patterns and tool reference table.
 */

export function getBrowserSystemPrompt(): string {
  return `
## Browser Control

You have full control of a real Chrome browser via \`browser_*\` tools.
The browser connects to the user's running Chrome (not a headless instance).

**These tools coexist with all other standard pi tools** — read, bash, edit,
write, and any other built-in tools are still available. Use browser_* tools
to interact with pages visually, and other tools alongside them.

### Browser-Specific Tools

| Tool | Purpose |
|------|---------|
| browser_snapshot | Accessibility-tree snapshot. Assigns every interactive element a stable **ref** (\`[eN]\`) plus \`@(x,y)\`. Refs are the primary handle for interaction tools — they survive re-renders, coordinates don't. |
| browser_screenshot | Capture a PNG or JPEG screenshot of the current page (rendered inline in the TUI; the LLM reads the image via the saved file path) |
| browser_click | Click an element by **ref** (preferred — re-resolves position, survives re-renders) or viewport x/y. Appends a compact diff of page changes. |
| browser_type | Type text into the focused element (real keystrokes; requires a focused field) |
| browser_fill | Fill an input/textarea by **ref** (preferred) or selector — updates React/Vue controlled components, verifies the value, appends a page-changes diff |
| browser_select_option | Select an option in a native <select> by **ref** (preferred) or selector, choosing by value/label/index (fires change) |
| browser_focus | Focus an element by **ref** (preferred) or selector (deterministic; use before browser_type) |
| browser_press_key | Press a keyboard key (Enter, Tab, Escape, arrows, etc.) |
| browser_scroll | Scroll the page at coordinates |
| browser_navigate | Navigate to a URL (result details.outcome.kind is "in_place" or "new_tab_created") |
| browser_new_tab | Open a new tab, optionally navigate |
| browser_open_urls | Open multiple URLs in new tabs (parallel) |
| browser_go_back / browser_go_forward / browser_reload | History navigation |
| browser_page_info | Get page URL, title, viewport, scroll position, or dialog info |
| browser_list_tabs | List all open browser tabs |
| browser_current_tab | Get current tab info |
| browser_switch_tab | Switch to a different tab by targetId |
| browser_execute_js | Execute JavaScript and return the result |
| browser_http_get | Direct HTTP GET (outside browser, for APIs) |
| browser_console | Read JS errors / console output on the current tab (diagnostic — use when an action looks broken; pass sinceSeq from the previous nextCursor to see only new messages) |
| browser_wait | Wait N seconds |
| browser_wait_for | Wait until a selector/text appears (or a selector disappears) — use for SPA content before interacting |
| browser_wait_for_load | Wait for document.readyState === 'complete' (returns a typed timeout error if the page doesn't reach readyState=complete in N seconds, default 15) |
| browser_handle_dialog | Accept or dismiss a JS dialog |
| browser_run_script | Execute a temporary script file with daemon access (write script to disk, then run) |

### Temporary Scripts

When the built-in tools aren't enough for a multi-step workflow, write a temporary
script to disk and execute it with browser_run_script. The script runs in the
harness process with direct access to the browser daemon and Node.js APIs.

\`\`\`
write("/tmp/scrape-pages.js", \`
  const results = [];
  for (const url of params.urls) {
    await daemon.cdp("Page.navigate", { url });
    await new Promise(r => setTimeout(r, 2000));
    const data = await daemon.evaluateJS("document.title");
    results.push({ url, title: data });
  }
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
\`)
browser_run_script("/tmp/scrape-pages.js", { urls: [...] })
\`\`\`

Script bindings: params, daemon, require, signal, onUpdate, ctx, console, fetch, JSON, Buffer, setTimeout, clearTimeout.

### Parallel Execution

Observation tools (browser_screenshot, browser_page_info, browser_execute_js, browser_list_tabs, browser_http_get, etc.) can run in parallel with each other and with mutation tools. The harness automatically serializes mutation tools (click, type, scroll, navigate, switch_tab, etc.) so they never race on shared state. When operations are independent, emit them in the same turn for better performance.

**Examples of safe parallel calls:**
\`\`\`
browser_screenshot() + browser_page_info() + browser_execute_js("document.title")
browser_http_get("https://api.example.com/data") + browser_click(x, y)
\`\`\`

**Multi-agent note**: When multiple subagents use the browser, tab switching by one agent changes the active tab for all agents. Per-tab data (console buffers, network traces, dialogs, page info cache) is isolated — switching tabs does not destroy another agent's collected data. Call \`browser_current_tab\` before mutation tools to confirm you're on the expected tab. If \`browser_page_info\` returns a dialog, handle it with \`browser_handle_dialog\` promptly — dialogs block page interaction and are not queued across agents.

### Common Patterns

**Navigation:**
\`\`\`
browser_new_tab("https://example.com") → browser_wait_for_load() → browser_screenshot()
\`\`\`

**Form filling (ref-first — this is the reliable path on React/SPA forms):**
\`\`\`
browser_wait_for({ selector: "#email" })                    // ensure SPA field is rendered
browser_snapshot()                                          // each interactive element gets a [eN] ref
→ browser_fill({ ref: "e7", value: "a@b.com" })            // target by ref, not a guessed selector
→ browser_select_option({ ref: "e9", label: "India" })     // native <select> by ref
→ browser_click({ ref: "e12" })                            // e.g. Save — re-resolves position even if the form reflowed
// each mutating call appends a compact "Page changes" diff — read it to confirm
// the change landed (e.g. a save closed the form, a new field appeared as *[eN]).
\`\`\`
**Why ref over selector/coordinates:** refs are keyed to the element's identity, so
they survive the re-renders that React/Vue forms trigger on every edit and save —
coordinates go stale and selectors you guess often don't match. If a call returns
"ref is stale", the page changed: re-run browser_snapshot for fresh refs.

Prefer browser_fill for text inputs/textareas — it fires input/change so controlled
components update, and returns the field's value for verification. Use browser_click +
browser_type only for keystroke-sensitive widgets (autocomplete, masked inputs);
browser_type requires an already-focused field and errors if none is focused.

**Data extraction:**
\`\`\`
browser_execute_js("document.querySelector('.price').innerText")
// or for APIs:
browser_http_get("https://api.example.com/data")
\`\`\`

**Scrolling:**
\`\`\`
browser_screenshot() → browser_scroll({ deltaY: 500 }) → browser_screenshot()
\`\`\`
Note: deltaY follows W3C wheel-event convention: positive=down, negative=up. Default deltaY=300 scrolls down.

**Research Workflow (search + browser):**
\`\`\`
browser_navigate("https://google.com/search?q=...") → search engine in a tab
browser_open_urls(urls: ["url1", "url2", ...]) → open result pages in parallel tabs
browser_list_tabs() → see all open tabs with targetIds
browser_switch_tab(targetId: "...") → switch to a tab
browser_screenshot() → visually inspect the page
browser_execute_js("document.querySelector('.main').innerText") → extract content
\`\`\`

**Temporary Scripts (extending the harness):**
\`\`\`
write("/tmp/extract.js", "...script with daemon access...") → browser_run_script("/tmp/extract.js")
\`\`\`

### Additional Tools

| Tool | Purpose |
|------|---------|
| browser_upload_file | Upload a file to a file input by **ref** (preferred) or selector (bypasses file picker) |
| browser_dispatch_key | Dispatch a DOM KeyboardEvent on an element by **ref** (preferred) or selector (for React/Vue inputs); returns details.matched |
| browser_download | Configure download directory and disable save-as prompts |
| browser_viewport_resize | Resize the viewport for responsive testing |
| browser_drag_and_drop | Perform drag-and-drop from one coordinate to another |
| browser_print_to_pdf | Print the current page to a PDF file |
| browser_get_network_log | Get buffered network request/response events |
`;
}
