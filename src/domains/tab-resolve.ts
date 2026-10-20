import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import type { ToolErr } from "../util/tool";

const HEX_PREFIX = /^[0-9A-Fa-f]{8,}$/;

export const ownershipDeniedMessage = (id: string, namespace: string): string =>
  `Tab ${id} is not owned by this harness session (namespace: ${namespace}). ` +
  `Use browser_list_tabs with scope:'all' to see it, or browser_new_tab to open one this session can control.`;

// Resolves a user-supplied target id against the tabs this session owns, and only those:
//   - an exact owned id resolves to itself;
//   - a hex prefix of 8+ characters resolves when it matches exactly one owned tab;
//   - a prefix matching several owned tabs is invalid_args;
//   - anything else (unowned id, prefix matching nothing owned) is invalid_state with the ownership message.
// Ownership is read from the registry, so no CDP round trip is made.
export const resolveOwnedTargetId = (client: BrowserClient, input: string): Result<string, ToolErr> => {
  if (client.owns(input)) return ok(input);
  if (HEX_PREFIX.test(input)) {
    const matches = client.ownership().list().filter((id) => id.startsWith(input));
    const first = matches[0];
    if (matches.length === 1 && first !== undefined) return ok(first);
    if (matches.length > 1) {
      return err({
        kind: "invalid_args",
        message: `Ambiguous prefix "${input}" matches ${matches.length} owned tabs: ${matches.join(", ")}`,
        details: { matches },
      });
    }
  }
  return err({
    kind: "invalid_state",
    message: ownershipDeniedMessage(input, client.namespace),
    details: { targetId: input, namespace: client.namespace },
  });
};
