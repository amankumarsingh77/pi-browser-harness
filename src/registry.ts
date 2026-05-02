import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "./client";
import { type AnyBrowserToolDefinition, registerBrowserTool } from "./util/tool";
import { clickTool } from "./domains/click";

const TOOLS: ReadonlyArray<AnyBrowserToolDefinition> = [
  clickTool,
];

export const registerAllTools = (pi: ExtensionAPI, client: BrowserClient): void => {
  for (const t of TOOLS) registerBrowserTool(pi, client, t);
};
