/**
 * pi-browser-harness — browser control extension for pi.
 *
 * Gives pi agents full control of a real Chrome browser via CDP.
 * Spawns the browser-harness daemon, registers browser_* tools,
 * and injects browser control guidance into the system prompt.
 *
 * Install:
 *   pi install npm:pi-browser-harness
 *   # or copy to .pi/extensions/pi-browser-harness/
 *
 * Commands:
 *   /browser-setup          — guided setup wizard
 *   /browser-status         — show daemon status and current page
 *   /browser-reload-daemon  — restart the daemon
 *
 * Flags:
 *   --browser-namespace <name>  — override BU_NAME (default: auto)
 *   --browser-debug-clicks       — enable debug click overlay
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { BrowserDaemon } from "./daemon";
import { getBrowserSystemPrompt } from "./prompt";
import { registerRenderers } from "./renderers";
import { registerSetupCommand } from "./setup";
import { type BrowserState, defaultState, persistState, restoreState } from "./state";
import { cleanupTempDirs, registerTools } from "./tools";
import { registerDynamicTools } from "./dynamic-tools";

export default function browserHarnessExtension(pi: ExtensionAPI) {
  // ── Resolve namespace ──────────────────────────────────────────────────────
  const flagNs = pi.getFlag("browser-namespace") as string | undefined;
  const namespace = flagNs || `pi-${Math.random().toString(36).slice(2, 10)}`;

  // ── State ──────────────────────────────────────────────────────────────────
  let state: BrowserState = defaultState(namespace);
  let daemon: BrowserDaemon | null = null;

  // ── Tool initialization flag ───────────────────────────────────────────────
  let toolsRegistered = false;

  // ═══════════════════════════════════════════════════════════════════════════
  // Flags
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerFlag("browser-namespace", {
    description: "Browser daemon namespace (BU_NAME). Default: auto-generated",
    type: "string",
  });
  pi.registerFlag("browser-debug-clicks", {
    description: "Enable debug click overlay (saves annotated screenshots to /tmp)",
    type: "boolean",
    default: false,
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Commands
  // ═══════════════════════════════════════════════════════════════════════════
  pi.registerCommand("browser-status", {
    description: "Show browser daemon status and current page",
    handler: async (_args, ctx) => {
      if (!daemon) {
        ctx.ui.notify("Browser daemon not started. Run /browser-setup first.", "warning");
        return;
      }

      const status = daemon.getStatus();
      const lines = [
        `Browser Daemon: ${status.alive ? "🟢 Connected" : "🔴 Disconnected"}`,
        `Namespace: ${status.namespace}`,
        `Socket: ${status.socketPath}`,
        `Session: ${status.sessionId || "none"}`,
        `PID: ${status.pid || "none"}`,
      ];

      if (status.remoteBrowserId) {
        lines.push(`Remote Browser: ${status.remoteBrowserId}`);
      }

      // Try to get current page info
      if (status.alive) {
        try {
          const info = await daemon.getPageInfo();
          if ("dialog" in info) {
            lines.push(`\n⚠️  Dialog open: ${info.dialog.type} — "${info.dialog.message}"`);
          } else {
            lines.push(`\nCurrent Page:`);
            lines.push(`  URL: ${info.url}`);
            lines.push(`  Title: ${info.title}`);
            lines.push(`  Viewport: ${info.width}x${info.height}`);
          }
        } catch {
          lines.push("\n(Could not read page info)");
        }
      }

      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("browser-reload-daemon", {
    description: "Restart the browser daemon",
    handler: async (_args, ctx) => {
      if (!daemon) {
        ctx.ui.notify("Browser daemon not started.", "warning");
        return;
      }

      ctx.ui.notify("Restarting browser daemon...", "info");
      try {
        await daemon.stop();
        await daemon.start();
        ctx.ui.notify("Browser daemon restarted ✓", "info");
      } catch (err) {
        ctx.ui.notify(
          `Restart failed: ${err instanceof Error ? err.message : String(err)}`,
          "error",
        );
      }
    },
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Session lifecycle
  // ═══════════════════════════════════════════════════════════════════════════
  pi.on("session_start", async (_event, ctx) => {
    // Restore persisted state (preserving the current namespace from flag)
    state = restoreState(ctx, state.namespace);

    // Create daemon instance
    daemon = new BrowserDaemon(state.namespace);

    // Attempt to start daemon (will fail gracefully if Chrome not connected)
    try {
      await daemon.start();
    } catch {
      // Don't block — user can run /browser-setup later
    }

    // Register tools (once)
    if (!toolsRegistered && daemon) {
      registerTools(pi, daemon);
      registerDynamicTools(pi, daemon);
      toolsRegistered = true;
    }

    // Register renderers
    registerRenderers(pi);

    // Setup command (always available)
    if (daemon) {
      registerSetupCommand(pi, daemon);
    }

    // Update status
    if (daemon.getStatus().alive) {
      ctx.ui.setStatus("browser", "🟢 Browser connected");
    } else {
      ctx.ui.setStatus("browser", "🔴 Browser — run /browser-setup");
    }
  });

  pi.on("session_shutdown", async (_event) => {
    // Persist current state
    if (state) {
      persistState(pi, state);
    }

    // Stop daemon
    if (daemon) {
      try {
        await daemon.stop();
      } catch {
        // best-effort
      }
      daemon = null;
    }

    toolsRegistered = false;

    // Clean up temp files from truncated tool outputs
    await cleanupTempDirs();
  });

  // Restore state on tree navigation
  pi.on("session_tree", async (_event, ctx) => {
    state = restoreState(ctx, daemon?.namespace);
    if (daemon) {
      persistState(pi, state);
    }
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // System prompt injection
  // ═══════════════════════════════════════════════════════════════════════════
  pi.on("before_agent_start", async (event) => {
    if (!daemon || !daemon.getStatus().alive) {
      // Browser not connected — inject minimal note
      return {
        systemPrompt:
          event.systemPrompt +
          `\n\n## Browser Control\n\nBrowser tools (browser_*) are available but the browser daemon is not connected. ` +
          `Run /browser-setup to connect to Chrome, or /browser-status to check.`,
      };
    }

    return {
      systemPrompt: event.systemPrompt + getBrowserSystemPrompt(),
    };
  });

  // ═══════════════════════════════════════════════════════════════════════════
  // Tool result hook: track tab history
  // ═══════════════════════════════════════════════════════════════════════════
  pi.on("tool_result", async (event) => {
    if (event.toolName === "browser_new_tab" || event.toolName === "browser_navigate") {
      // Track new tabs in history
      const details = event.details as { targetId?: string } | undefined;
      if (details?.targetId) {
        state = {
          ...state,
          tabHistory: [details.targetId, ...state.tabHistory.filter((id) => id !== details.targetId)].slice(0, 20),
        };
        persistState(pi, state);
      }
    }
  });
}
