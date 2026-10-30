import { ALL_TOOLS } from "./registry";
import type { BrowserTool, ToolConcurrency } from "./util/tool";

// The lane text is derived from each tool's own `concurrency`, so a tool can never
// be mis-described as observational while actually taking the mutation mutex.
export type PromptTool = Pick<BrowserTool, "name" | "concurrency">;

export type LaneNames = {
  readonly serialized: ReadonlyArray<string>;
  readonly parallel: ReadonlyArray<string>;
};

const TOOL_PREFIX = "browser_";

// Lane lists use the short form (click, not browser_click) to keep the prompt compact; the
// prefix is universal and stated once in the prose above the list.
export const shortToolName = (name: string): string =>
  name.startsWith(TOOL_PREFIX) ? name.slice(TOOL_PREFIX.length) : name;

export const laneNames = (tools: ReadonlyArray<PromptTool>): LaneNames => {
  const lane = (c: ToolConcurrency): ReadonlyArray<string> => tools.filter((t) => t.concurrency === c).map((t) => t.name);
  return { serialized: lane("serialized"), parallel: lane("parallel") };
};

const joinShort = (names: ReadonlyArray<string>): string => names.map(shortToolName).join(", ");

export function getBrowserSystemPrompt(connected = true, tools: ReadonlyArray<PromptTool> = ALL_TOOLS): string {
  const connectionNotice = connected
    ? ""
    : "Browser is not connected. Run browser_setup or /browser-setup to connect.\n\n";
  const lanes = laneNames(tools);
  return `
## Browser Control

${connectionNotice}You control the user's running Chrome through \`browser_*\` tools alongside the
standard pi tools. Per-tool usage lives in tool descriptions, parameter schemas,
and tool-specific guidelines.

- Operate only inside this session's owned Chrome window. Never reach into the
  user's other tabs or windows. Close owned tabs once no later step needs them.
- Tools in the serialized lane (${joinShort(lanes.serialized)}) run one at a time.
  Tools in the parallel lane (${joinShort(lanes.parallel)}) may run concurrently
  with them. \`browser_run_script\` bypasses that lane: keep mutating scripts
  sequential with other browser calls. Parallelize only independent calls.
- Agents sharing a session share its active tab. Check \`browser_current_tab\`
  before a mutation to confirm the expected tab when another agent may switch it.
- Read any appended "Page changes" diff to confirm an interaction. Tools without a
  diff, including \`browser_run_script\`, need explicit state verification.
- Pages commonly render several near-identical forms in one view (edit dialogs, reply
  boxes, comment panels, filter bars). Distinguish targets by the enclosing form's
  \`action\` or a unique field \`id\` — never selector first-match — and confirm the
  filled/returned value identifies the form you meant before submitting.
- For irreversible submits (posting, deleting, paying, sending): take
  \`browser_screenshot\` to confirm the intended target first, then verify the result by
  its artifact — re-read the page, follow the redirect URL, or query the backend — rather
  than trusting the DOM you just mutated. \`form.requestSubmit()\` succeeding is not proof
  the right form submitted.
- If a tool reports "ref is stale", call \`browser_snapshot\` for fresh refs before
  retrying; do not reuse the stale handle.
`;
}
