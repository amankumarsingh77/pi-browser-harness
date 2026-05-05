import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "./client";
import { type AnyBrowserToolDefinition, registerBrowserTool } from "./util/tool";
import { clickTool } from "./domains/click";
import { typeTool, pressKeyTool, dispatchKeyTool } from "./domains/keyboard";
import { pageInfoTool, waitTool, waitForLoadTool } from "./domains/page";
import { scrollTool } from "./domains/scroll";
import { handleDialogTool } from "./domains/dialog";
import { screenshotTool } from "./domains/screenshot";
import { navigateTool, openUrlsTool } from "./domains/navigate";
import { goBackTool, goForwardTool, reloadTool } from "./domains/history";
import { listTabsTool, currentTabTool, switchTabTool, newTabTool, closeTabTool } from "./domains/tabs";
import { uploadFileTool, downloadTool, printToPdfTool } from "./domains/files";
import { viewportResizeTool } from "./domains/viewport";
import { dragAndDropTool } from "./domains/drag";
import { httpGetTool, getNetworkLogTool } from "./domains/network";
import { executeJsTool, runScriptTool } from "./domains/js";

// Mutation tools that modify page / browser state are marked `serialized: true`
// so they run through a shared async mutex.  Observation / read-only tools are
// left unmarked and can execute in parallel.
const TOOLS: ReadonlyArray<AnyBrowserToolDefinition> = [
  { ...clickTool, serialized: true },
  { ...typeTool, serialized: true },
  { ...pressKeyTool, serialized: true },
  { ...dispatchKeyTool, serialized: true },
  { ...scrollTool, serialized: true },
  pageInfoTool,
  waitTool,
  { ...waitForLoadTool, serialized: true },
  { ...handleDialogTool, serialized: true },
  screenshotTool,
  { ...navigateTool, serialized: true },
  { ...openUrlsTool, serialized: true },
  { ...goBackTool, serialized: true },
  { ...goForwardTool, serialized: true },
  { ...reloadTool, serialized: true },
  listTabsTool,
  currentTabTool,
  { ...switchTabTool, serialized: true },
  { ...newTabTool, serialized: true },
  { ...closeTabTool, serialized: true },
  { ...uploadFileTool, serialized: true },
  { ...downloadTool, serialized: true },
  { ...printToPdfTool, serialized: true },
  { ...viewportResizeTool, serialized: true },
  { ...dragAndDropTool, serialized: true },
  httpGetTool,
  getNetworkLogTool,
  executeJsTool,
  runScriptTool,
];

export const registerAllTools = (pi: ExtensionAPI, client: BrowserClient): void => {
  for (const t of TOOLS) registerBrowserTool(pi, client, t);
};
