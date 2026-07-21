/**
 * System prompt guidance for browser usage.
 *
 * Injects a compact browser control reference into the pi system prompt.
 * This prompt carries only cross-cutting knowledge — the mental model, tool
 * routing, workflows, and gotchas. Per-tool specifics (schemas, detailed usage)
 * are injected separately via promptGuidelines on each tool registration, so this
 * file intentionally does NOT restate full tool descriptions.
 */

export function getBrowserSystemPrompt(): string {
  return `
## Browser Control

You drive a **real Chrome** (the user's running instance, not headless) through
\`browser_*\` tools. These coexist with every standard pi tool — read, bash, edit,
write — so mix them freely: \`browser_*\` for the page, everything else alongside.

### The core handle: refs

Interaction is ref-first. Call \`browser_snapshot\` to get an accessibility tree
where every interactive element has a stable ref (\`[eN]\`) and \`@(x,y)\`. **Target
elements by ref, not by coordinates or guessed selectors** — refs are keyed to
element identity, so they survive the re-renders that React/Vue forms trigger on
every edit and save. Coordinates go stale; guessed selectors miss.

- Prefer \`browser_fill\` for text — it fires input/change so controlled components
  update, and returns the value for verification. Use \`browser_click\` + \`browser_type\`
  only for keystroke-sensitive widgets (autocomplete, masked inputs).
- Mutating calls append a compact **"Page changes"** diff — read it to confirm the
  change landed (form closed, new \`*[eN]\` appeared).
- \`"ref is stale"\` means the page changed: re-run \`browser_snapshot\` for fresh refs.

### Choosing a tool

| To… | Reach for |
|-----|-----------|
| See the page structure (for interaction) | \`browser_snapshot\` (refs) |
| See the page visually | \`browser_screenshot\` |
| Search the web | \`browser_web_search\` → ranked {title, url, snippet} |
| Read an article's clean text | \`browser_read_page\` (reader mode; url or owned tab) |
| Extract specific DOM values | \`browser_execute_js\` |
| Hit a JSON/API endpoint | \`browser_http_get\` (raw GET, outside the browser) |
| Click / fill / type / select / focus / press a key | \`browser_click\` · \`browser_fill\` · \`browser_type\` · \`browser_select_option\` · \`browser_focus\` · \`browser_press_key\` |
| Upload a file · drag · resize viewport | \`browser_upload_file\` · \`browser_drag_and_drop\` · \`browser_viewport_resize\` |
| Go to a URL / open many / manage tabs | \`browser_navigate\` · \`browser_new_tab\` · \`browser_open_urls\` · \`browser_list_tabs\` · \`browser_switch_tab\` · \`browser_go_back\`/\`go_forward\`/\`reload\` |
| Wait for content / load / a fixed delay | \`browser_wait_for\` (selector/text) · \`browser_wait_for_load\` (readyState) · \`browser_wait\` |
| Inspect page / handle a dialog | \`browser_page_info\` · \`browser_current_tab\` · \`browser_handle_dialog\` |
| Diagnose a broken action | \`browser_console\` (JS errors) · \`browser_get_network_log\` |
| Save output / config downloads | \`browser_print_to_pdf\` · \`browser_download\` |
| Anything the tools can't express | \`browser_run_script\` (see Extending) |

Each tool carries its own detailed guidelines — this table is only for routing.

### Workflows

**Research (search → read):**
\`\`\`
browser_web_search("query")        // ranked links, no page content
→ browser_read_page(url)           // clean article text for the top hits
// fall back to browser_open_urls + browser_execute_js only when reader mode misses
\`\`\`

**Form filling (ref-first — the reliable path on SPA forms):**
\`\`\`
browser_wait_for({ selector: "#email" })   // ensure the field is rendered
browser_snapshot()                          // interactive elements get [eN] refs
→ browser_fill({ ref: "e7", value: "a@b.com" })
→ browser_select_option({ ref: "e9", label: "India" })
→ browser_click({ ref: "e12" })             // re-resolves position even after reflow
// read each "Page changes" diff to confirm the step landed
\`\`\`

**Navigate + verify:**
\`\`\`
browser_new_tab("https://example.com") → browser_wait_for_load() → browser_screenshot()
\`\`\`

**Scroll:** \`browser_scroll({ deltaY: 500 })\` — W3C wheel convention: positive = down,
negative = up (default 300, down).

### Parallelism

Observation tools (\`browser_screenshot\`, \`browser_page_info\`, \`browser_execute_js\`,
\`browser_list_tabs\`, \`browser_http_get\`, \`browser_web_search\`, \`browser_read_page\`, …)
run in parallel with each other and with mutations. The harness serializes mutations
(click, type, scroll, navigate, switch_tab) so they never race. Emit independent calls
in one turn:
\`\`\`
browser_screenshot() + browser_page_info() + browser_execute_js("document.title")
\`\`\`

**Multi-agent:** tab switching by one agent changes the active tab for all agents,
but per-tab data (console, network, dialogs) stays isolated. Call \`browser_current_tab\`
before a mutation to confirm you're on the expected tab. Handle any dialog reported by
\`browser_page_info\` promptly — dialogs block interaction and aren't queued across agents.

**Session boundary & tab hygiene:** you operate only inside this session's own Chrome
window. \`browser_switch_tab\`/\`browser_close_tab\` refuse tabs this session didn't open,
and \`browser_list_tabs\` defaults to owned tabs — never reach into the user's other tabs
or windows. Close tabs when you're done with them: call \`browser_close_tab\` on any tab
you opened (via \`browser_new_tab\`/\`browser_open_urls\`) once you've extracted what you
need. Don't leave a pile of stale tabs behind — keep only what a later step still needs.
(Leftover tabs are closed automatically when the session ends, but close them yourself
as you go.)

### Extending: temporary scripts

When built-in tools can't express a multi-step workflow, write a script to a temp file
and run it with \`browser_run_script\`. It executes in the harness process with direct
daemon + Node access.
\`\`\`
write(<tempfile>.js, \`
  const results = [];
  for (const url of params.urls) {
    await daemon.cdp("Page.navigate", { url });
    await new Promise(r => setTimeout(r, 2000));
    results.push({ url, title: await daemon.evaluateJS("document.title") });
  }
  return { content: [{ type: "text", text: JSON.stringify(results, null, 2) }] };
\`)
browser_run_script(<tempfile>.js, { urls: [...] })
\`\`\`
Script bindings: params, daemon, require, signal, onUpdate, ctx, console, fetch, JSON,
Buffer, setTimeout, clearTimeout. Use a real temp path from the OS — don't hardcode \`/tmp\`.
`;
}
