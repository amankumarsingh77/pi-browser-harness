import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "./client";
import { type AnyBrowserToolDefinition, registerBrowserTool } from "./util/tool";
import { clickTool } from "./domains/click";
import { typeTool, pressKeyTool, dispatchKeyTool } from "./domains/keyboard";
import { fillTool, selectOptionTool, focusTool, setCheckedTool } from "./domains/form";
import { fillFormTool } from "./domains/form-batch";
import { pageInfoTool, waitTool, waitForLoadTool, waitForTool } from "./domains/page";
import { scrollTool } from "./domains/scroll";
import { handleDialogTool } from "./domains/dialog";
import { screenshotTool } from "./domains/screenshot";
import { navigateTool, openUrlsTool } from "./domains/navigate";
import { goBackTool, goForwardTool, reloadTool } from "./domains/history";
import { listTabsTool, currentTabTool, switchTabTool, newTabTool, closeTabTool } from "./domains/tabs";
import { uploadFileTool, downloadTool, printToPdfTool } from "./domains/files";
import { viewportResizeTool } from "./domains/viewport";
import { dragAndDropTool } from "./domains/drag";
import { httpGetTool, networkRequestsTool } from "./domains/network";
import { consoleTool } from "./domains/console";
import { snapshotTool } from "./domains/snapshot";
import { executeJsTool, runScriptTool } from "./domains/js";
import { setupTool } from "./domains/setup";
import { webSearchTool } from "./domains/search/web-search";
import { readPageTool } from "./domains/readpage/read-page";

export const ALL_TOOLS: ReadonlyArray<AnyBrowserToolDefinition> = [
  setupTool,
  clickTool,
  typeTool,
  fillTool,
  fillFormTool,
  selectOptionTool,
  setCheckedTool,
  focusTool,
  pressKeyTool,
  dispatchKeyTool,
  scrollTool,
  pageInfoTool,
  waitTool,
  waitForTool,
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
  closeTabTool,
  uploadFileTool,
  downloadTool,
  printToPdfTool,
  viewportResizeTool,
  dragAndDropTool,
  httpGetTool,
  networkRequestsTool,
  consoleTool,
  snapshotTool,
  executeJsTool,
  runScriptTool,
  webSearchTool,
  readPageTool,
];

export const registerAllTools = (pi: ExtensionAPI, client: BrowserClient): void => {
  for (const t of ALL_TOOLS) registerBrowserTool(pi, client, t);
};
