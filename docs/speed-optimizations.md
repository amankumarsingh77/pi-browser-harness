# Pi Agent Features for Blazingly Fast Browser Automation

> Deep research on every pi agent capability that can be leveraged to make `pi-browser-harness` as fast as possible.

---

## 1. Parallel Execution (The Biggest Speed Multiplier)

| Feature | How It Makes Browser Harness Fast |
|---------|-----------------------------------|
| **Parallel Tool Execution (Default)** | Pi executes sibling tool calls from the same assistant message **concurrently** by default. Multiple `browser_click`, `browser_type`, `browser_scroll`, or `browser_http_get` calls on independent targets run simultaneously instead of sequentially. |
| **`browser_open_urls`** | Opens multiple URLs in **parallel new tabs** in one shot. For research/scraping workflows, this eliminates sequential navigation delays entirely. |
| **Parallel `browser_execute_js` across tabs** | After listing tabs, you can switch to each tab and extract data in parallel batches rather than one-by-one. |
| **Parallel `browser_http_get`** | Direct HTTP GETs outside the browser are independent of browser state—fire dozens of API calls simultaneously. |
| **Read + Browser tools in same turn** | `read` (file system) and `browser_*` tools can run in parallel in the same turn because they hit different resources. |
| **`withFileMutationQueue()`** | For custom tools that write files, this queues mutations per-file so parallel tool execution doesn't cause race conditions/overwrite bugs. |

### Patterns

```typescript
// Open all result pages at once
browser_open_urls({ urls: ["url1", "url2", "url3"] })

// Then extract from each tab in parallel batches
browser_switch_tab(targetId1) → browser_execute_js("...")
browser_switch_tab(targetId2) → browser_execute_js("...")
```

---

## 2. Batching & Scripting (Eliminate Round-Trips)

| Feature | How It Makes Browser Harness Fast |
|---------|-----------------------------------|
| **`browser_run_script`** | Write a temporary `.js` script and execute it with **full daemon + Node.js access**. This is the single biggest speedup for multi-step browser workflows—scrape 47 paginated pages, bulk-export CSV, or run complex CDP sequences in **one round-trip** instead of 47 screenshot→click loops. |
| **Custom Tools via Extensions (`pi.registerTool`)** | Register high-level browser tools like `batch_extract`, `bulk_screenshot`, or `auto_login` that internally run multiple CDP commands. The LLM calls one tool; the extension does the orchestration. |
| **Dynamic Tool Registration** | Tools can be registered at runtime (e.g., after detecting a page type). This lets you inject specialized, fast-path tools only when needed. |
| **Early Termination (`terminate: true`)** | Custom tools can return `terminate: true` to hint that no follow-up LLM turn is needed. For structured extraction tasks, this saves an entire model call. |
| **`onUpdate` streaming in custom tools** | Stream partial results back while long browser scripts run, so the user sees progress without waiting for full completion. |

### When to Use Scripts vs. Built-in Tools

| Use Scripts | Use Built-in Tools |
|-------------|-------------------|
| Same 3+ step sequence repeated | One-off actions |
| Bulk CSV export, structured extraction, pagination | Simple click or type |
| Domain-specific reusable pattern | Quick screenshot verification |

```typescript
// Example: Batch extraction script
write("/tmp/extract-products.js", `
  const data = await daemon.evaluateJs(\`
    JSON.stringify(Array.from(document.querySelectorAll('${params.rowSelector}')).map(el => ({
      title: el.querySelector('${params.titleSelector}')?.textContent?.trim(),
      price: el.querySelector('${params.priceSelector}')?.textContent?.trim(),
    })))
  \`);
  return { content: [{ type: 'text', text: data }], details: { raw: JSON.parse(data) } };
`)
browser_run_script("/tmp/extract-products.js", { rowSelector: "...", titleSelector: "...", priceSelector: "..." })
```

---

## 3. Subagents & Delegation (Scale Across Cores/Sessions)

| Feature | How It Makes Browser Harness Fast |
|---------|-----------------------------------|
| **Parallel subagent tasks** | Launch multiple `scout`, `researcher`, or `worker` agents simultaneously with `tasks: [...]`. Each can control its own browser tab or perform independent research. |
| **Async/background runs (`async: true`)** | Launch a long-running browser automation (e.g., full test suite, deep crawl) in the background while the parent agent continues working. |
| **Chain execution** | Sequence dependent steps (e.g., `scout` → `planner` → `worker`) with `{previous}` and `{chain_dir}` templating so each step doesn't rediscover context. |
| **Worktree isolation (`worktree: true`)** | Run parallel agents on isolated git worktrees so concurrent file writes don't conflict—essential for parallel browser-based testing or scraping pipelines. |
| **File-only output mode (`outputMode: "file-only"`)** | For subagents, return compact file references instead of inline text. This prevents massive context bloat on the parent session, keeping subsequent turns fast. |
| **Forked context (`context: "fork"`)** | Spawn advisory `oracle` or `reviewer` agents that inherit parent history but run on a branched session—no context copying overhead. |

### Example: Parallel Research with Browser

```typescript
subagent({
  tasks: [
    { agent: "scout", task: "Audit frontend auth flow" },
    { agent: "researcher", task: "Research current retry/backoff best practices" }
  ],
  concurrency: 2
})
```

---

## 4. Event Interception & Mutation (Optimize at the Harness Level)

| Feature | How It Makes Browser Harness Fast |
|---------|-----------------------------------|
| **`tool_call` event interception** | Block, modify, or batch tool arguments before execution. Example: detect three sequential `browser_click` calls and rewrite them into a single `browser_run_script` batch. |
| **`tool_result` event modification** | Post-process raw browser output (e.g., truncate huge HTML, extract only diff, cache repeated queries) before it hits the LLM context. |
| **`before_agent_start` / `context` events** | Inject pre-computed page state or strip unnecessary history before the LLM call, reducing token count and latency. |
| **`input` event transformation** | Transform user prompts before they reach the agent. Example: expand `!{selector}` inline bash or auto-convert "scrape all links" into a batched script invocation. |
| **AbortSignal (`ctx.signal`)** | Cancel long-running browser operations (navigation, waits, downloads) immediately when the user hits Escape or a turn ends. |

### Example: Extension-Level Batching

```typescript
pi.on("tool_call", async (event, ctx) => {
  if (event.toolName === "browser_click" && shouldBatch(event.input)) {
    // Rewrite into a script call
    event.input = { scriptPath: "/tmp/batch-clicks.js", params: { clicks: [...] } };
  }
});
```

---

## 5. Context Efficiency (Keep Token Latency Low)

| Feature | How It Makes Browser Harness Fast |
|---------|-----------------------------------|
| **Automatic Compaction** | Proactively summarizes old messages when approaching the context window. For long browser sessions (multi-page crawls), this prevents slowdowns from oversized contexts. |
| **Custom Compaction via Extensions** | Override compaction logic to preserve critical browser state (current URL, cookies, form data) while summarizing away redundant screenshots or HTML dumps. |
| **Context Files (`AGENTS.md`)** | Load browser-specific conventions once at startup. The model doesn't need to relearn "always screenshot before clicking" every turn. |
| **Skills (Progressive Disclosure)** | Browser-specific skills (like `pi-browser-harness`) only load their full instructions when needed. The system prompt stays lean until a browser task is detected. |
| **`PI_CACHE_RETENTION=long`** | Extended prompt cache retention (Anthropic: 1h, OpenAI: 24h) means repeated browser-tool-heavy prompts reuse cached prefixes, cutting latency and cost. |

### Settings for Long Browser Sessions

```json
{
  "compaction": {
    "enabled": true,
    "reserveTokens": 16384,
    "keepRecentTokens": 20000
  }
}
```

---

## 6. Provider & Model Control (Speed at the LLM Layer)

| Feature | How It Makes Browser Harness Fast |
|---------|-----------------------------------|
| **Model Cycling (`Ctrl+P`)** | Switch to faster/cheaper models for simple browser tasks (e.g., `gpt-4o-mini` for extraction) and reserve heavy models for complex reasoning. |
| **Thinking Level Control (`Shift+Tab`)** | Set thinking to `off` or `minimal` for deterministic browser automation, eliminating reasoning latency when it's not needed. |
| **Custom Providers (`pi.registerProvider`)** | Route browser-heavy sessions through faster proxies, local endpoints, or team-wide caches. |
| **Transport Selection (`sse` vs `websocket`)** | Choose the lowest-latency transport for your provider. |
| **`before_provider_request` hook** | Inspect or rewrite the provider payload to inject cache-control markers, strip unnecessary tool definitions, or enable prompt caching for repeated browser schemas. |

---

## 7. Session Architecture (Never Lose Speed to State Management)

| Feature | How It Makes Browser Harness Fast |
|---------|-----------------------------------|
| **Session Branching (`/tree`, `/fork`)** | Experiment with different browser strategies without losing state. If one automation path is slow, fork and try another without rebuilding context from scratch. |
| **Session Compaction (`/compact`)** | Manually trigger compaction mid-session after a heavy crawl to instantly restore context window headroom. |
| **`pi.appendEntry()`** | Persist browser state (cookies, auth tokens, current page index) as custom session entries. Restore on resume without re-authenticating or re-navigating. |
| **Custom Commands (`pi.registerCommand`)** | Register `/browser-batch` or `/crawl` commands that kick off optimized script-based workflows without LLM involvement. |

---

## 8. UI & Control Flow (Reduce Human-in-the-Loop Delay)

| Feature | How It Makes Browser Harness Fast |
|---------|-----------------------------------|
| **Message Queue (`steer` / `followUp`)** | Queue corrective messages while the agent is mid-crawl. The browser harness receives steering immediately after the current tool batch instead of waiting for full completion. |
| **Custom UI / Overlays** | Build a live browser dashboard (status line showing current URL, progress bar for crawls) so the user doesn't interrupt prematurely. |
| **`browser_page_info` dialog detection** | Instantly detect blocking JS dialogs instead of timing out. Extensions can auto-dismiss known popups via `tool_call` interception. |

---

## Summary: The "Blazingly Fast" Formula

To maximize browser harness speed with pi:

1. **Parallelize everything** — Use `browser_open_urls`, parallel tool execution, and parallel subagents.
2. **Script heavy sequences** — Use `browser_run_script` for any 3+ step repetitive flow.
3. **Build custom tools** — Register batch tools via extensions to collapse multi-turn loops into single tool calls.
4. **Intercept and optimize** — Use `tool_call`/`tool_result` events to batch, cache, and truncate before the LLM sees it.
5. **Keep context lean** — Use compaction, file-only subagent output, and skills to prevent token bloat.
6. **Delegate asynchronously** — Launch long crawls as `async` subagents while the parent continues.
7. **Choose the right model** — Cycle to fast models with minimal thinking for deterministic automation.
