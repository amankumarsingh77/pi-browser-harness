/**
 * Deep research — the /deep-research slash command. An explicit entry point
 * (alongside the auto-triggering deep-research skill) that kicks off a research
 * run for a given question.
 *
 * The command is thin: it validates a non-empty question and injects a user
 * message that starts the deep-research flow. The actual orchestration
 * (decompose → fan out web-search-researcher subagents → synthesize a cited
 * report) lives in skills/deep-research/SKILL.md, which the injected prompt
 * triggers. pi.sendUserMessage always starts a turn.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

// ── Shared core: build the prompt that starts a deep-research run ───────────

export function buildDeepResearchPrompt(question: string): string {
  return (
    `Do deep research on the following question and produce a cited Markdown report. ` +
    `Use the deep-research skill: decompose it into sub-questions, fan out web-search-researcher ` +
    `subagents to research each against the live web, then synthesize a source-cited report file.\n\n` +
    `Question: ${question}`
  );
}

// ── Public: register the /deep-research slash command ──────────────────────

export function registerDeepResearchCommand(pi: ExtensionAPI): void {
  pi.registerCommand("deep-research", {
    description: "Research a question on the web and write a cited report",
    handler: async (args, ctx) => {
      const question = args.trim();
      if (question.length === 0) {
        ctx.ui.notify('Usage: /deep-research <question>. Example: /deep-research "compare CDP vs WebDriver"', "warning");
        return;
      }
      ctx.ui.notify(`Starting deep research: ${question}`, "info");
      pi.sendUserMessage(buildDeepResearchPrompt(question));
    },
  });
}
