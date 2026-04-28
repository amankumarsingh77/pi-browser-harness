/**
 * Setup command — guides the user through installing and connecting
 * browser-harness to their Chrome browser.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import type { BrowserDaemon } from "./daemon";

export function registerSetupCommand(pi: ExtensionAPI, daemon: BrowserDaemon): void {
  pi.registerCommand("browser-setup", {
    description: "Install and connect browser-harness to Chrome",
    handler: async (_args, ctx) => {
      await runSetup(ctx, daemon);
    },
  });
}

async function runSetup(ctx: ExtensionContext, daemon: BrowserDaemon): Promise<void> {
  ctx.ui.notify("browser-harness setup: checking installation...", "info");

  // Step 1: Check for browser-harness installation
  const bhInstalled = await checkBrowserHarnessInstalled();
  if (!bhInstalled) {
    ctx.ui.notify(
      "browser-harness not found. Installing...",
      "warning",
    );
    const installed = await installBrowserHarness(ctx);
    if (!installed) {
      ctx.ui.notify(
        "Installation failed. Please install manually:\n" +
          "  git clone https://github.com/browser-use/browser-harness ~/Developer/browser-harness\n" +
          "  cd ~/Developer/browser-harness && uv sync",
        "error",
      );
      return;
    }
  }

  ctx.ui.notify("browser-harness found ✓", "info");

  // Step 2: Check Chrome is running
  const chromeRunning = checkChromeRunning();
  if (!chromeRunning) {
    ctx.ui.notify(
      "Chrome/Chromium/Edge not detected. Please start your browser and retry /browser-setup.",
      "error",
    );
    return;
  }
  ctx.ui.notify("Chrome is running ✓", "info");

  // Step 3: Try to start the daemon
  ctx.ui.notify("Connecting to Chrome...", "info");
  try {
    await daemon.start();
    ctx.ui.notify("Daemon connected ✓", "info");
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    const lower = msg.toLowerCase();

    if (
      lower.includes("devtoolsactiveport") ||
      lower.includes("remote debugging")
    ) {
      ctx.ui.notify(
        "Chrome remote debugging needs to be enabled.\n\n" +
          "Start Chrome with: --remote-debugging-port=9222\n" +
          "Then run /browser-setup again.",
        "warning",
      );
      return;
    }

    ctx.ui.notify(`Connection failed: ${msg}`, "error");
    return;
  }

  // Step 4: Verify with test navigation
  ctx.ui.notify("Testing browser control...", "info");
  try {
    await daemon.newTab("https://github.com/browser-use/browser-harness");
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

// ── Helpers ──────────────────────────────────────────────────────────────────

async function checkBrowserHarnessInstalled(): Promise<boolean> {
  const searchPaths = [
    join(homedir(), "Developer", "browser-harness"),
    join(homedir(), "src", "browser-harness"),
    join(homedir(), "browser-harness"),
    join(homedir(), "dev", "browser-harness"),
    join(homedir(), "Projects", "browser-harness"),
    process.cwd(),
  ];

  for (const dir of searchPaths) {
    if (
      existsSync(join(dir, "daemon.py")) &&
      existsSync(join(dir, "helpers.py"))
    ) {
      return true;
    }
  }

  // Check if uv tool is installed globally
  try {
    execSync("uv tool list 2>/dev/null | grep browser-harness", { timeout: 5000 });
    return true;
  } catch {
    // not found via uv
  }

  return false;
}

async function installBrowserHarness(ctx: ExtensionContext): Promise<boolean> {
  // Try uv tool install
  try {
    ctx.ui.notify("Installing browser-harness via uv...", "info");
    execSync("uv tool install browser-harness", {
      timeout: 60_000,
      stdio: "pipe",
    });
    return true;
  } catch {
    // uv install failed
  }

  // Try git clone
  try {
    const targetDir = join(homedir(), "Developer", "browser-harness");
    ctx.ui.notify(`Cloning browser-harness to ${targetDir}...`, "info");
    execSync(
      `git clone https://github.com/browser-use/browser-harness "${targetDir}"`,
      { timeout: 30_000, stdio: "pipe" },
    );
    execSync("uv sync", { cwd: targetDir, timeout: 60_000, stdio: "pipe" });
    return true;
  } catch {
    return false;
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
