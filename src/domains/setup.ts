/**
 * browser_setup tool — agent-callable browser initialization.
 *
 * The agent can call this directly when browser tools fail with
 * "not initialized" instead of asking the user. Idempotent: safe
 * to call even when already connected.
 */

import { Type } from "typebox";
import { Text } from "@mariozechner/pi-tui";
import type { Result } from "../util/result";
import { err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { performSetup } from "../setup";

const SetupArgs = Type.Object({});

export const setupTool = defineBrowserTool({
  name: "browser_setup",
  label: "Browser Setup",
  description:
    "Initialize browser control. Spawns the daemon, connects to Chrome, opens a test tab. " +
    "Call when browser tools fail with 'Browser harness not initialized'. Idempotent.",
  promptSnippet: "Initialize browser connection",
  promptGuidelines: [
    "Call browser_setup when you get a 'Browser harness not initialized' error from any browser tool.",
    "This tool is idempotent — calling it when already connected is harmless.",
    "After browser_setup succeeds, retry the browser tool that failed.",
  ],
  parameters: SetupArgs,
  // ensureAlive:false — this tool IS the setup; it must bypass the socket guard
  ensureAlive: false,
  renderCall: () => new Text("🔧 Initializing browser...", 0, 0),
  async handler(_args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const result = await performSetup(client);
    if (result.success) {
      return ok({ text: result.data });
    }
    return err({ kind: "internal", message: result.error });
  },
});
