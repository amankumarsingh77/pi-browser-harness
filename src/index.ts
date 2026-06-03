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

export default function browserHarnessExtension(pi: ExtensionAPI): void {
  const flagNs = pi.getFlag("browser-namespace") as string | undefined;
  const namespace = flagNs ?? `pi-${Math.random().toString(36).slice(2, 10)}`;

  let state: BrowserState = defaultState(namespace);
  let client: BrowserClient | null = null;
  let toolsRegistered = false;
  let browserToolsEnabled = state.toolsEnabled ?? true;
  const browserToolNames = new Set<string>();

  const applyBrowserToolPolicy = (): void => {
    const active = new Set(pi.getActiveTools());
    for (const name of browserToolNames) {
      if (browserToolsEnabled) active.add(name);
      else active.delete(name);
    }
    pi.setActiveTools([...active]);
  };

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

  pi.registerCommand("browser-enable", {
    description: "Enable browser tools for this session",
    handler: async (_args, ctx) => {
      browserToolsEnabled = true;
      state = { ...state, toolsEnabled: true };
      persistState(pi, state);
      applyBrowserToolPolicy();
      ctx.ui.setStatus("browser", client?.status().alive ? "🟢 Browser enabled" : "⚪ Browser enabled lazily");
      ctx.ui.notify("Browser tools enabled. Chrome will connect lazily on first browser_* tool call.", "info");
    },
  });

  pi.registerCommand("browser-disable", {
    description: "Disable browser tools for this session",
    handler: async (_args, ctx) => {
      browserToolsEnabled = false;
      state = { ...state, toolsEnabled: false };
      persistState(pi, state);
      applyBrowserToolPolicy();
      ctx.ui.setStatus("browser", "⚪ Browser disabled");
      ctx.ui.notify("Browser tools disabled for this session.", "info");
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    state = restoreState(ctx, state.namespace);
    browserToolsEnabled = state.toolsEnabled ?? true;
    const initialOwnership: { ownedTargetIds?: ReadonlyArray<string>; harnessWindowTargetId?: string } = {};
    if (state.ownedTargetIds !== undefined) initialOwnership.ownedTargetIds = state.ownedTargetIds;
    if (state.harnessWindowTargetId !== undefined) initialOwnership.harnessWindowTargetId = state.harnessWindowTargetId;
    client = createBrowserClient({
      namespace: state.namespace,
      ...(Object.keys(initialOwnership).length > 0 ? { initialOwnership } : {}),
      onOwnershipChange: (snap) => {
        state = {
          ...state,
          ownedTargetIds: snap.ownedTargetIds,
          ...(snap.harnessWindowTargetId !== undefined
            ? { harnessWindowTargetId: snap.harnessWindowTargetId }
            : {}),
        };
        persistState(pi, state);
      },
    });
    if (!toolsRegistered) {
      registerAllTools(pi, client);
      for (const tool of pi.getAllTools()) {
        if (tool.name.startsWith("browser_")) browserToolNames.add(tool.name);
      }
      toolsRegistered = true;
    }
    applyBrowserToolPolicy();
    registerSetupCommand(pi, client);
    ctx.ui.setStatus("browser", browserToolsEnabled ? "⚪ Browser enabled lazily" : "⚪ Browser disabled");
  });

  pi.on("session_shutdown", async () => {
    persistState(pi, state);
    if (client) {
      try {
        await client.stop();
      } catch (e) {
        // Shutdown is best-effort, but a stuck stop() points at a transport
        // bug worth surfacing for debugging.
        console.warn("[pi-browser-harness] client.stop() failed during shutdown:", e);
      }
      client = null;
    }
    toolsRegistered = false;
    await cleanupTempDirs();
  });

  pi.on("session_tree", async (_event, ctx) => {
    state = restoreState(ctx, client?.namespace);
    persistState(pi, state);
  });

  pi.on("before_agent_start", async (event) => {
    if (!browserToolsEnabled) return { systemPrompt: event.systemPrompt };

    if (!client || !client.status().alive) {
      return {
        systemPrompt:
          event.systemPrompt +
          `\n\n## Browser Control\n\nBrowser tools (browser_*) are enabled and will connect lazily on first use. Run /browser-setup for guided setup if connection fails.`,
      };
    }
    return { systemPrompt: event.systemPrompt + getBrowserSystemPrompt() };
  });
}
