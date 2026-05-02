import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "./client";
import { type AnyBrowserToolDefinition, registerBrowserTool } from "./util/tool";

const TOOLS: ReadonlyArray<AnyBrowserToolDefinition> = [
  // Domain tools registered as they're migrated, one per domain file.
];

export const registerAllTools = (pi: ExtensionAPI, client: BrowserClient): void => {
  for (const t of TOOLS) registerBrowserTool(pi, client, t);
};
