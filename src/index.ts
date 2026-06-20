/**
 * pi-browser-harness — browser control extension for pi.
 *
 * Gives pi agents full control of a real Chrome browser via CDP.
 * Connects to the user's running Chrome (chrome://inspect/#remote-debugging),
 * registers browser_* tools, and injects browser control guidance into the
 * system prompt.
 *
 * Install:
 *   pi install npm:pi-browser-harness
 *   # or copy to .pi/extensions/pi-browser-harness/
 *
 * Commands:
 *   /browser-setup          — guided setup wizard
 *   /browser-status         — show client status and current page
 *   /browser-reload-daemon  — restart the browser client
 *
 * Flags:
 *   --browser-namespace <name>   — override namespace (default: auto)
 *   --browser-debug-clicks       — enable debug click overlay
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type BrowserClient, createBrowserClient } from "./client";
import { getBrowserSystemPrompt } from "./prompt";
import { registerSetupCommand } from "./setup";
import { type BrowserState, defaultState, persistState, restoreState } from "./state";
import { registerAllTools } from "./registry";
import { cleanupTempDirs } from "./util/truncate";
import { createDaemonTransport } from "./cdp/daemon-transport";
import { ensureDaemon } from "./daemon/spawn";

export default function browserHarnessExtension(pi: ExtensionAPI): void {
  const flagNs = pi.getFlag("browser-namespace") as string | undefined;
  const namespace = flagNs ?? `pi-${Math.random().toString(36).slice(2, 10)}`;

  let state: BrowserState = defaultState(namespace);
  let client: BrowserClient | null = null;
  let toolsRegistered = false;

  pi.registerFlag("browser-namespace", {
    description: "Browser daemon namespace. Default: auto-generated",
    type: "string",
  });
  pi.registerFlag("browser-debug-clicks", {
    description: "Enable debug click overlay (saves annotated screenshots to /tmp)",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("browser-status", {
    description: "Show browser connection status and current page",
    handler: async (_args, ctx) => {
      if (!client) {
        ctx.ui.notify("Browser client not started. Run /browser-setup first.", "warning");
        return;
      }
      const s = client.status();
      const lines = [
        `Browser: ${s.alive ? "🟢 Connected" : "🔴 Disconnected"}`,
        `Session: ${s.sessionId ?? "none"}`,
      ];
      if (s.remoteBrowserId) lines.push(`Browser ID: ${s.remoteBrowserId}`);
      if (s.alive) {
        const info = await client.pageInfo();
        if (info.success) {
          if ("dialog" in info.data) {
            lines.push(`\n⚠️  Dialog open: ${info.data.dialog.type} — "${info.data.dialog.message}"`);
          } else {
            lines.push(
              `\nCurrent Page:`,
              `  URL: ${info.data.url}`,
              `  Title: ${info.data.title}`,
              `  Viewport: ${info.data.width}x${info.data.height}`,
            );
          }
        }
      }
      ctx.ui.notify(lines.join("\n"), "info");
    },
  });

  pi.registerCommand("browser-reload-daemon", {
    description: "Restart the browser client",
    handler: async (_args, ctx) => {
      if (!client) {
        ctx.ui.notify("Browser client not started.", "warning");
        return;
      }
      ctx.ui.notify("Restarting browser client...", "info");
      await client.stop();
      const r = await client.start();
      if (r.success) {
        ctx.ui.notify("Browser client restarted ✓", "info");
      } else {
        ctx.ui.notify(`Restart failed: ${r.error.message}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    state = restoreState(ctx, state.namespace);

    // Lazy-init: create the client once and reuse it across sessions.
    // The daemon transport keeps the CDP connection alive between sessions,
    // eliminating the "Allow Remote Debugging" prompt on every restart.
    if (!client) {
      const initialOwnership: { ownedTargetIds?: ReadonlyArray<string>; harnessWindowTargetId?: string } = {};
      if (state.ownedTargetIds !== undefined) initialOwnership.ownedTargetIds = state.ownedTargetIds;
      if (state.harnessWindowTargetId !== undefined) initialOwnership.harnessWindowTargetId = state.harnessWindowTargetId;

      // Try daemon transport first (auto-spawns daemon if needed).
      // Fall back to direct WebSocket if daemon can't start.
      const daemonAvailable = await ensureDaemon();
      const transport = daemonAvailable
        ? createDaemonTransport(state.namespace)
        : undefined;

      client = createBrowserClient({
        namespace: state.namespace,
        ...(transport ? { transport } : {}),
        ...(Object.keys(initialOwnership).length > 0 ? { initialOwnership } : {}),
        onOwnershipChange: (snap) => {
          state = {
            ...state,
            ownedTargetIds: snap.ownedTargetIds,
            ...(snap.harnessWindowTargetId !== undefined
              ? { harnessWindowTargetId: snap.harnessWindowTargetId }
              : {}),
          };
          // Ownership changes can fire from CDP events at any time,
          // including after session replacement when pi's ctx is stale.
          // Persistence is best-effort — failure must not crash the event consumer.
          // ponytail: try/catch is the simplest guard against stale-ctx.
          try { persistState(pi, state); } catch { /* stale ctx — safe to ignore */ }
        },
      });
    }

    // start() is a no-op if already connected (transport is open and session is attached)
    await client.start();

    if (!toolsRegistered) {
      registerAllTools(pi, client);
      toolsRegistered = true;
    }
    registerSetupCommand(pi, client);
    ctx.ui.setStatus(
      "browser",
      client.status().alive ? "🟢 Browser connected" : "🔴 Browser — run /browser-setup",
    );
  });

  pi.on("session_shutdown", async () => {
    persistState(pi, state);
    if (client) {
      try {
        // Detach from the page target (removes the "Chrome is being controlled"
        // banner) but keep the transport alive for the next session.
        await client.detach();
      } catch (e) {
        console.warn("[pi-browser-harness] client.detach() failed during shutdown:", e);
      }
      // ponytail: keep the transport alive across sessions.
      // Do NOT call client.stop() or null out client — the daemon connection
      // persists and eliminates the per-session "Allow Remote Debugging" prompt.
      // Only Chrome restart or daemon death triggers a new prompt.
    }
    await cleanupTempDirs();
  });

  pi.on("session_tree", async (_event, ctx) => {
    state = restoreState(ctx, client?.namespace);
    persistState(pi, state);
  });

  pi.on("before_agent_start", async (event) => {
    if (!client || !client.status().alive) {
      return {
        systemPrompt:
          event.systemPrompt +
          `\n\n## Browser Control\n\nBrowser tools (browser_*) are available but the browser is not connected. Run /browser-setup.`,
      };
    }
    return { systemPrompt: event.systemPrompt + getBrowserSystemPrompt() };
  });
}
