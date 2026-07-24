/**
 * Setup — verifies Chrome is running with remote debugging and connects
 * the pi agent to it. Exposed as both a slash command (/browser-setup) for
 * users and a tool (browser_setup) for the agent to self-recover.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "./client";
import { ensureDaemon } from "./daemon/spawn";
import { DAEMON_SOCKET_PATH } from "./daemon/protocol";
import { isBrowserRunning } from "./profile/browser-process";
import { promptForProfileIfUnset } from "./profile/command";

// ── Public: register the /browser-setup slash command ──────────────────────

export function registerSetupCommand(pi: ExtensionAPI, client: BrowserClient): void {
  pi.registerCommand("browser-setup", {
    description: "Connect pi to your Chrome browser",
    handler: async (_args, ctx) => {
      const result = await performSetup(client, ctx);
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

export async function performSetup(client: BrowserClient, ctx?: ExtensionContext): Promise<SetupResult> {
  // Step 1: Check Chrome is running
  const chromeRunning = await isBrowserRunning();
  if (!chromeRunning) {
    return { success: false, error: "No browser instance running. Please open your browser and then run /browser-setup." };
  }

  // Step 2: Start the browser daemon (spawns if not running, silently reuses if alive)
  const daemonReady = await ensureDaemon();
  if (!daemonReady) {
    return { success: false, error: `Could not start the browser daemon. Check ${DAEMON_SOCKET_PATH}.` };
  }

  // Step 3: Ask which profile to work in, the first time only. Enumeration
  // reads DevToolsActivePort + Local State from disk, so it works before the
  // connection exists. Declining leaves the pre-profile behavior untouched —
  // this must never block setup.
  const profileNote = await promptForProfileIfUnset(client, ctx);

  // Step 4: Connect to Chrome DevTools
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

  // Step 5: Verify with test navigation
  const tabResult = await client.newTab("https://github.com");
  if (!tabResult.success) {
    return { success: false, error: `Browser connected but test navigation failed: ${tabResult.error.message}` };
  }

  const info = await client.pageInfo();
  if (info.success && "dialog" in info.data) {
    await client.session().call("Page.handleJavaScriptDialog", { accept: true });
  }

  const pageUrl = info.success && !("dialog" in info.data) ? info.data.url : "github.com";
  const lines = ["Browser connected ✓", `Navigated to: ${pageUrl}`];
  if (profileNote) lines.push(profileNote);
  return { success: true, data: lines.join("\n") };
}

// ── Chrome process detection ───────────────────────────────────────────────
//
// Detection moved to src/profile/browser-process.ts, which answers the same
// "is a browser running?" question per platform and additionally reports the
// executable path and any explicit --user-data-dir that profile selection needs.
