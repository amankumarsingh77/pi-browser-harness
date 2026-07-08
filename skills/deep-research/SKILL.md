---
name: deep-research
description: Use when the user asks you to research a topic on the web, do deep research, investigate something across multiple sources, or produce a cited report / literature review from the live web. Decomposes the question, fans out isolated web-search-researcher subagents (one per sub-question) that scrape the real browser, then synthesizes a source-cited Markdown report. Trigger phrases include "research", "deep research", "look this up and cite sources", "investigate", "compare X and Y with sources".
---

# Deep Research

Turn a research question into a **cited Markdown report** by fanning out to isolated `web-search-researcher` subagents that use the real browser, then synthesizing their distilled findings. Every claim in the final report carries a source link.

This runs on two browser tools — `browser_web_search` (ranked SERP, links only) and `browser_read_page` (URL → clean article text) — used *inside the subagents*, not by you directly. Both tools open their own isolated tabs, so **the fan-out never disturbs the user's tabs or current page.** You do not need `/browser-setup` to have been run by you; if the browser isn't connected the subagents' first tool call will report `not_connected` — relay that and ask the user to run `/browser-setup`.

## Workflow

### 1. Decompose

Break the question into **3–6 focused sub-questions**, each independently answerable from the web. Cover the distinct facets — definitions, current state, competing options, trade-offs, recent changes — not slight rewordings of the same thing. Aim for coverage: if you synthesized perfect answers to all sub-questions, the original question should be fully answered.

State the sub-questions to the user before dispatching (a short numbered list) so the plan is visible.

### 2. Fan out

Dispatch **one `web-search-researcher` subagent per sub-question**, in parallel where the runtime allows. Each subagent runs in isolated context and returns a distilled, source-linked finding (claims + urls) — not raw pages. Give each subagent exactly one sub-question plus any constraints (recency, specific ecosystem, authoritative sources to prefer).

Do not do the searching yourself — that is the subagents' job, and their isolation is what keeps your context clean enough to synthesize well.

### 3. Assess coverage — loop with a hard ceiling

After each round of findings, self-assess: **is every sub-question answered, or did findings surface new gaps worth a follow-up search?**

- If gaps remain and you are under the ceiling, dispatch a second round of researchers targeting only the gaps (rephrased or newly discovered sub-questions).
- **Hard ceiling:** at most **2 rounds** and **8 researcher subagents total**. When you hit either limit, stop searching, synthesize with what you have, and list the unresolved gaps explicitly in the report. Never loop indefinitely chasing completeness.

Handle subagent-reported tool failures:
- A subagent reporting a `browser_web_search` `invalid_state` with `reason: "captcha"` means a bot wall. **Surface this to the user immediately** and do not spawn a tight retry loop — ask whether to continue, wait, or narrow scope.
- `reason: "no_results"` is already handled inside the subagent (one rephrase); if it still comes back empty, treat that sub-question as a gap.

### 4. Synthesize a cited report

Merge the distilled findings into a **Markdown report written to a file** (e.g. `research-<topic-slug>.md` in the working directory — tell the user the path). Structure:

```
# {The research question}

## Summary
{A few paragraphs answering the question, synthesized across sources.}

## {Sub-topic / sub-question 1}
{Findings, in prose. Every claim carries a source link inline: … as shown in [Title](url).}

## {Sub-topic 2}
...

## Open questions / gaps
{Anything the ceiling left unresolved, or where sources conflicted.}

## Sources
{Deduplicated list of every URL cited, with titles.}
```

Rules for the report:
- **Every factual claim carries a source link** — inline `[title](url)`. No unsourced assertions.
- **Attribute conflicts.** Where sources disagree, present both and cite each.
- **Distinguish synthesis from quotation.** Don't fabricate precision the sources didn't provide.
- **Be honest about gaps.** The gaps section is mandatory when the ceiling cut off coverage — an incomplete-but-honest report beats a complete-looking-but-padded one.

After writing the file, give the user a short chat summary and the file path — don't paste the whole report into the conversation.
