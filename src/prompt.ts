export function getBrowserSystemPrompt(connected = true): string {
  const connectionNotice = connected
    ? ""
    : "Browser is not connected. Run browser_setup or /browser-setup to connect.\n\n";
  return `
## Browser Control

${connectionNotice}You control the user's running Chrome through \`browser_*\` tools alongside the
standard pi tools. Per-tool usage lives in tool descriptions, parameter schemas,
and tool-specific guidelines.

- Operate only inside this session's owned Chrome window. Never reach into the
  user's other tabs or windows. Close owned tabs once no later step needs them.
- Only tools in the mutation lane are serialized; observations may run concurrently
  with them. \`browser_run_script\` bypasses that lane: keep mutating scripts sequential
  with other browser calls. Parallelize only independent calls.
- Agents sharing a session share its active tab. Check \`browser_current_tab\`
  before a mutation to confirm the expected tab when another agent may switch it.
- Read any appended "Page changes" diff to confirm an interaction. Tools without a
  diff, including \`browser_run_script\`, need explicit state verification.
- If a tool reports "ref is stale", call \`browser_snapshot\` for fresh refs before
  retrying; do not reuse the stale handle.
`;
}
