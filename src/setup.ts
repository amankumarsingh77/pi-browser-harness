/**
 * Setup command — verifies Chrome is running with remote debugging
 * and connects the pi agent to it.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import type { BrowserClient } from "./client";

export function registerSetupCommand(pi: ExtensionAPI, client: BrowserClient): void {
  pi.registerCommand("browser-setup", {
    description: "Connect pi to your Chrome browser",
    handler: async (_args, ctx) => {
      await runSetup(ctx, client);
    },
  });
}

async function runSetup(ctx: ExtensionContext, client: BrowserClient): Promise<void> {
  ctx.ui.notify("browser setup: checking Chrome...", "info");

  // Step 1: Check Chrome is running
  const chromeRunning = checkChromeRunning();
  if (!chromeRunning) {
    ctx.ui.notify(
      "No browser instance running. Please open your browser and then run /browser-setup.",
      "error",
    );
    return;
  }
  ctx.ui.notify("Chrome is running ✓", "info");

  // Step 2: Try to connect to Chrome DevTools
  ctx.ui.notify("Connecting to Chrome DevTools...", "info");
  const startResult = await client.start();
  if (!startResult.success) {
    const msg = startResult.error.message;
    const lower = msg.toLowerCase();

    if (
      lower.includes("devtoolsactiveport") ||
      lower.includes("remote debugging") ||
      lower.includes("econnrefused") ||
      lower.includes("cannot reach chrome devtools")
    ) {
      ctx.ui.notify(
        "Chrome remote debugging needs to be enabled.\n\n" +
          "Open chrome://inspect/#remote-debugging in your browser, tick the\n" +
          "\"Discover network targets\" / Allow checkbox, then run /browser-setup again.\n\n" +
          "Or set BU_CDP_WS to a remote browser WebSocket URL.",
        "warning",
      );
      return;
    }

    ctx.ui.notify(`Connection failed: ${msg}`, "error");
    return;
  }
  ctx.ui.notify("Connected to Chrome ✓", "info");

  // Step 3: Verify with test navigation
  ctx.ui.notify("Testing browser control...", "info");
  const tabResult = await client.newTab("https://github.com");
  if (!tabResult.success) {
    ctx.ui.notify(
      `Browser connected but test navigation failed: ${tabResult.error.message}`,
      "warning",
    );
    return;
  }

  const info = await client.pageInfo();
  if (info.success && "dialog" in info.data) {
    await client.session().call("Page.handleJavaScriptDialog", { accept: true });
  }

  const pageUrl = info.success && !("dialog" in info.data) ? info.data.url : "github.com";
  ctx.ui.notify(`Browser control verified ✓\nNavigated to: ${pageUrl}`, "info");
}

function checkChromeRunning(): boolean {
  try {
    if (process.platform === "darwin") {
      // Exact line matching — excludes "Google Chrome Helper" etc.
      // that linger after the user quits the browser.
      const out = execSync("ps -A -o comm=", { timeout: 5000 }).toString().toLowerCase();
      const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
      const browserProcesses = ["google chrome", "chromium", "microsoft edge"];
      return lines.some((l) => {
        if (l.includes("helper") || l.includes("renderer")) return false;
        return browserProcesses.includes(l);
      });
    } else if (process.platform === "linux") {
      // Use args to distinguish the main browser process from sub-processes
      // (GPU, renderer, utility, etc.) which carry --type= flags.
      const out = execSync("ps -A -o comm=,args=", { timeout: 5000 }).toString().toLowerCase();
      const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
      const browserComms = ["chrome", "chromium", "chromium-browser", "msedge", "microsoft-edge", "google-chrome"];
      return lines.some((line) => {
        const parts = line.split(/\s+/);
        const comm = parts[0] ?? "";
        if (!comm || !browserComms.includes(comm)) return false;
        const isSubprocess = line.includes("--type=") && !line.includes("--type=browser");
        return !isSubprocess;
      });
    } else if (process.platform === "win32") {
      const out = execSync("tasklist", { timeout: 5000 }).toString().toLowerCase();
      return ["chrome.exe", "msedge.exe"].some((n) => out.includes(n));
    }
  } catch {
    // best-effort
  }
  return false;
}
