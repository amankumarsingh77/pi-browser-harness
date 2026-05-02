import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "./client";
import { type AnyBrowserToolDefinition, registerBrowserTool } from "./util/tool";
import { clickTool } from "./domains/click";
import { typeTool, pressKeyTool, dispatchKeyTool } from "./domains/keyboard";
import { scrollTool } from "./domains/scroll";

const TOOLS: ReadonlyArray<AnyBrowserToolDefinition> = [
  clickTool,
  typeTool,
  pressKeyTool,
  dispatchKeyTool,
  scrollTool,
];

export const registerAllTools = (pi: ExtensionAPI, client: BrowserClient): void => {
  for (const t of TOOLS) registerBrowserTool(pi, client, t);
};
