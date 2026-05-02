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
import { listTabsTool, currentTabTool, switchTabTool, newTabTool } from "./domains/tabs";
import { uploadFileTool, downloadTool, printToPdfTool } from "./domains/files";
import { viewportResizeTool } from "./domains/viewport";
import { dragAndDropTool } from "./domains/drag";
import { httpGetTool, getNetworkLogTool } from "./domains/network";

const TOOLS: ReadonlyArray<AnyBrowserToolDefinition> = [
  clickTool,
  typeTool,
  pressKeyTool,
  dispatchKeyTool,
  scrollTool,
  pageInfoTool,
  waitTool,
  waitForLoadTool,
  handleDialogTool,
  screenshotTool,
  navigateTool,
  openUrlsTool,
  goBackTool,
  goForwardTool,
  reloadTool,
  listTabsTool,
  currentTabTool,
  switchTabTool,
  newTabTool,
  uploadFileTool,
  downloadTool,
  printToPdfTool,
  viewportResizeTool,
  dragAndDropTool,
  httpGetTool,
  getNetworkLogTool,
];

export const registerAllTools = (pi: ExtensionAPI, client: BrowserClient): void => {
  for (const t of TOOLS) registerBrowserTool(pi, client, t);
};
