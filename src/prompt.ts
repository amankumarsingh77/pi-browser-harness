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
| browser_screenshot | Capture a PNG screenshot of the current page |
| browser_click | Click at viewport coordinates |
| browser_type | Type text into the focused element |
| browser_press_key | Press a keyboard key (Enter, Tab, Escape, arrows, etc.) |
| browser_scroll | Scroll the page at coordinates |
| browser_navigate | Navigate to a URL |
| browser_new_tab | Open a new tab, optionally navigate |
| browser_open_urls | Open multiple URLs in new tabs (parallel) |
| browser_go_back / browser_go_forward / browser_reload | History navigation |
| browser_page_info | Get page URL, title, viewport, scroll position, or dialog info |
| browser_list_tabs | List all open browser tabs |
| browser_current_tab | Get current tab info |
| browser_switch_tab | Switch to a different tab by targetId |
| browser_execute_js | Execute JavaScript and return the result |
| browser_http_get | Direct HTTP GET (outside browser, for APIs) |
| browser_wait | Wait N seconds |
| browser_wait_for_load | Wait for document.readyState === 'complete' |
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

### Common Patterns

**Navigation:**
\`\`\`
browser_new_tab("https://example.com") → browser_wait_for_load() → browser_screenshot()
\`\`\`

**Form filling:**
\`\`\`
browser_screenshot() → find input coordinates → browser_click(x, y)
→ browser_type("text") → browser_press_key("Tab") → browser_screenshot()
\`\`\`

**Data extraction:**
\`\`\`
browser_execute_js("document.querySelector('.price').innerText")
// or for APIs:
browser_http_get("https://api.example.com/data")
\`\`\`

**Scrolling:**
\`\`\`
browser_screenshot() → browser_scroll({ deltaY: -500 }) → browser_screenshot()
\`\`\`

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
`;
}
