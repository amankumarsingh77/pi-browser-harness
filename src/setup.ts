/**
 * Setup — verifies Chrome is running with remote debugging and connects
 * the pi agent to it. Exposed as both a slash command (/browser-setup) for
 * users and a tool (browser_setup) for the agent to self-recover.
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { execSync } from "node:child_process";
import type { BrowserClient } from "./client";
import { ensureDaemon } from "./daemon/spawn";
import { DAEMON_SOCKET_PATH } from "./daemon/protocol";

// ── Public: register the /browser-setup slash command ──────────────────────

export function registerSetupCommand(pi: ExtensionAPI, client: BrowserClient): void {
  pi.registerCommand("browser-setup", {
    description: "Connect pi to your Chrome browser",
    handler: async (_args, ctx) => {
      const result = await performSetup(client);
      if (result.success) {
        ctx.ui.notify(result.data, "info");
      } else {
        ctx.ui.notify(result.error, "error");
      }
    },
  });
}

// ── Shared setup result ────────────────────────────────────────────────────

export type SetupResult = { success: true; data: string } | { success: false; error: string };

// ── Shared setup logic (used by both the command and the tool) ─────────────

export async function performSetup(client: BrowserClient): Promise<SetupResult> {
  // Step 1: Check Chrome is running
  const chromeRunning = checkChromeRunning();
  if (!chromeRunning) {
    return { success: false, error: "No browser instance running. Please open your browser and then run /browser-setup." };
  }

  // Step 2: Start the browser daemon (spawns if not running, silently reuses if alive)
  const daemonReady = await ensureDaemon();
  if (!daemonReady) {
    return { success: false, error: `Could not start the browser daemon. Check ${DAEMON_SOCKET_PATH}.` };
  }

  // Step 3: Connect to Chrome DevTools
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
      return {
        success: false,
        error:
          "Browser remote debugging needs to be enabled.\n\n" +
          "Open chrome://inspect/#remote-debugging (or brave://inspect,\n" +
          "edge://inspect) in your browser, tick the\n" +
          '"Discover network targets" / Allow checkbox, then retry.\n\n' +
          "If that doesn't expose DevTools, relaunch the browser with\n" +
          "--remote-debugging-port=9222.\n\n" +
          "Or set BU_CDP_WS to a remote browser WebSocket URL.",
      };
    }

    return { success: false, error: `Connection failed: ${msg}` };
  }

  // Step 4: Verify with test navigation
  const tabResult = await client.newTab("https://github.com");
  if (!tabResult.success) {
    return { success: false, error: `Browser connected but test navigation failed: ${tabResult.error.message}` };
  }

  const info = await client.pageInfo();
  if (info.success && "dialog" in info.data) {
    await client.session().call("Page.handleJavaScriptDialog", { accept: true });
  }

  const pageUrl = info.success && !("dialog" in info.data) ? info.data.url : "github.com";
  return { success: true, data: `Browser connected ✓\nNavigated to: ${pageUrl}` };
}

// ── Chrome process detection ───────────────────────────────────────────────

function checkChromeRunning(): boolean {
  try {
    if (process.platform === "darwin") {
      // ps -o comm= returns the full executable path on modern macOS, e.g.
      // "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser". We check
      // for a known Chromium-family name anywhere in the path (case-insensitive),
      // excluding helper/renderer/gpu/crashpad/updater subprocesses that linger
      // after the user quits the browser.
      const out = execSync("ps -A -o comm=", { timeout: 5000 }).toString().toLowerCase();
      const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
      const browserNames = ["google chrome", "chromium", "microsoft edge", "brave browser"];
      return lines.some((l) => {
        if (
          l.includes("helper") ||
          l.includes("renderer") ||
          l.includes("crashpad") ||
          l.includes(" gpu") ||
          l.includes("updater")
        ) return false;
        return browserNames.some((name) => l.includes(name));
      });
    } else if (process.platform === "linux") {
      const out = execSync("ps -A -o comm=,args=", { timeout: 5000 }).toString().toLowerCase();
      const lines = out.split("\n").map((l) => l.trim()).filter(Boolean);
      const browserComms = [
        "chrome", "chromium", "chromium-browser", "msedge", "microsoft-edge",
        "google-chrome", "brave", "brave-browser",
      ];
      return lines.some((line) => {
        const parts = line.split(/\s+/);
        const comm = parts[0] ?? "";
        if (!comm || !browserComms.includes(comm)) return false;
        const isSubprocess = line.includes("--type=") && !line.includes("--type=browser");
        return !isSubprocess;
      });
    } else if (process.platform === "win32") {
      const out = execSync("tasklist", { timeout: 5000 }).toString().toLowerCase();
      return ["chrome.exe", "msedge.exe", "brave.exe"].some((n) => out.includes(n));
    }
  } catch {
    // best-effort
  }
  return false;
}
