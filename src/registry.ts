import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "./client";
import type { BrowserTool } from "./util/tool";
import { type Result, err, ok } from "./util/result";
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
import { clearHeadersTool, setHeadersTool } from "./domains/headers";
import { consoleTool } from "./domains/console";
import { snapshotTool } from "./domains/snapshot";
import { executeJsTool, runScriptTool } from "./domains/js";
import { setupTool } from "./domains/setup";
import { webSearchTool } from "./domains/search/web-search";
import { readPageTool } from "./domains/readpage/read-page";
import { saveRecipeTool } from "./recipes/save-tool";

export const ALL_TOOLS: ReadonlyArray<BrowserTool> = [
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
  setHeadersTool,
  clearHeadersTool,
  consoleTool,
  snapshotTool,
  executeJsTool,
  runScriptTool,
  webSearchTool,
  readPageTool,
  saveRecipeTool,
];

export type RegistryError = {
  readonly kind: "duplicate_name";
  readonly message: string;
};

// The only surface pi needs for tool registration; keeping it narrow lets tests pass a sink
// instead of a full ExtensionAPI.
export type ToolRegistrar = Pick<ExtensionAPI, "registerTool">;

export type ToolRegistry = {
  // Current contents, in insertion order. Built-ins come first, contributed tools after.
  readonly tools: () => ReadonlyArray<BrowserTool>;
  // Append one tool. Rejects a name already present so a contributor cannot shadow a built-in
  // (or another contributor) silently; the first registration wins.
  readonly add: (tool: BrowserTool) => Result<void, RegistryError>;
  // Append a batch atomically: a name clash anywhere in it (with the registry or within the batch)
  // rejects the whole call and leaves the registry untouched.
  readonly addAll: (tools: ReadonlyArray<BrowserTool>) => Result<void, RegistryError>;
  // Register every tool that has not been registered with pi yet. Safe to call on every
  // session_start: tools added after an earlier call land on the next one.
  readonly register: (pi: ToolRegistrar, client: BrowserClient) => void;
};

const duplicateName = (name: string): RegistryError => ({
  kind: "duplicate_name",
  message: `A browser tool named "${name}" is already registered; pick a distinct name`,
});

export const createToolRegistry = (initial: ReadonlyArray<BrowserTool> = ALL_TOOLS): ToolRegistry => {
  const tools: BrowserTool[] = [];
  const names = new Set<string>();
  const registered = new Set<string>();

  const addAll = (batch: ReadonlyArray<BrowserTool>): Result<void, RegistryError> => {
    const seen = new Set<string>();
    const clash = batch.find((t) => names.has(t.name) || seen.has(t.name) || (seen.add(t.name), false));
    if (clash) return err(duplicateName(clash.name));
    for (const tool of batch) {
      names.add(tool.name);
      tools.push(tool);
    }
    return ok(undefined);
  };
  const add = (tool: BrowserTool): Result<void, RegistryError> => addAll([tool]);

  for (const tool of initial) {
    const added = add(tool);
    if (!added.success) throw new Error(added.error.message);
  }

  return {
    tools: () => [...tools],
    add,
    addAll,
    register: (pi, client) => {
      for (const tool of tools) {
        if (registered.has(tool.name)) continue;
        tool.register(pi, client);
        registered.add(tool.name);
      }
    },
  };
};
