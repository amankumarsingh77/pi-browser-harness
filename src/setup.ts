/**
 * Setup command — verifies Chrome is running with remote debugging
 * and connects the pi agent to it.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import type { BrowserDaemon } from "./daemon";

export function registerSetupCommand(pi: ExtensionAPI, daemon: BrowserDaemon): void {
  pi.registerCommand("browser-setup", {
    description: "Connect pi to your Chrome browser",
    handler: async (_args, ctx) => {
      await runSetup(ctx, daemon);
    },
  });
}

async function runSetup(ctx: ExtensionContext, daemon: BrowserDaemon): Promise<void> {
  ctx.ui.notify("browser setup: checking Chrome...", "info");

  // Step 1: Check Chrome is running
  const chromeRunning = checkChromeRunning();
  if (!chromeRunning) {
    ctx.ui.notify(
      "Chrome/Chromium/Edge not detected. Please start your browser and retry /browser-setup.",
      "error",
    );
    return;
  }
  ctx.ui.notify("Chrome is running ✓", "info");

  // Step 2: Try to connect to Chrome DevTools
  ctx.ui.notify("Connecting to Chrome DevTools...", "info");
  try {
    await daemon.start();
    ctx.ui.notify("Connected to Chrome ✓", "info");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
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

  // Step 3: Verify with test navigation
  ctx.ui.notify("Testing browser control...", "info");
  try {
    await daemon.newTab("https://github.com");
    const info = await daemon.getPageInfo();
    if ("dialog" in info) {
      await daemon.cdp("Page.handleJavaScriptDialog", { accept: true });
    }
    ctx.ui.notify(
      `Browser control verified ✓\nNavigated to: ${"url" in info ? info.url : "github.com"}`,
      "info",
    );
  } catch (err) {
    ctx.ui.notify(
      `Browser connected but test navigation failed: ${err instanceof Error ? err.message : String(err)}`,
      "warning",
    );
  }
}

function checkChromeRunning(): boolean {
  try {
    if (process.platform === "darwin" || process.platform === "linux") {
      const out = execSync("ps -A -o comm=", { timeout: 5000 }).toString().toLowerCase();
      return ["google chrome", "chrome", "chromium", "microsoft edge", "msedge"].some(
        (n) => out.includes(n),
      );
    } else if (process.platform === "win32") {
      const out = execSync("tasklist", { timeout: 5000 }).toString().toLowerCase();
      return ["chrome.exe", "msedge.exe"].some((n) => out.includes(n));
    }
  } catch {
    // best-effort
  }
  return false;
}
