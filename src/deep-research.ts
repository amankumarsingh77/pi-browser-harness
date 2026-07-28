
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";


export function buildDeepResearchPrompt(question: string): string {
  return (
    `Do deep research on the following question and produce a cited Markdown report. ` +
    `Use the deep-research skill: decompose it into sub-questions, fan out web-search-researcher ` +
    `subagents to research each against the live web, then synthesize a source-cited report file.\n\n` +
    `Question: ${question}`
  );
}


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
