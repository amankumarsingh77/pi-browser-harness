import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type BrowserClient, createBrowserClient } from "./client";
import { getBrowserSystemPrompt } from "./prompt";
import { registerSetupCommand } from "./setup";
import { registerProfileCommand } from "./profile/command";
import { readPin } from "./profile/store";
import { registerDeepResearchCommand } from "./deep-research";
import { type BrowserState, defaultState, persistState, restoreState } from "./state";
import { registerAllTools } from "./registry";
import { cleanupTempDirs } from "./util/truncate";
import { createDaemonTransport } from "./cdp/daemon-transport";
import { asString } from "./util/guards";

export default function browserHarnessExtension(pi: ExtensionAPI): void {
  const flagNs = asString(pi.getFlag("browser-namespace"));
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
      const pin = client.profilePin();
      const lines = [
        `Browser: ${s.alive ? "🟢 Connected" : "🔴 Disconnected"}`,
        `Profile: ${pin ? pin.label : "not selected (uses whichever window is focused) — run /browser-profile"}`,
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

    // Re-read the on-disk profile pin every session start: another pi session may have changed it since this client was created.
    const profilePin = await readPin();

    if (!client) {
      const transport = createDaemonTransport(state.namespace);

      const initialOwnership: { ownedTargetIds?: ReadonlyArray<string>; harnessWindowTargetId?: string; harnessWindowId?: number } = {};
      if (state.ownedTargetIds !== undefined) initialOwnership.ownedTargetIds = state.ownedTargetIds;
      if (state.harnessWindowTargetId !== undefined) initialOwnership.harnessWindowTargetId = state.harnessWindowTargetId;
      if (state.harnessWindowId !== undefined) initialOwnership.harnessWindowId = state.harnessWindowId;

      client = createBrowserClient({
        namespace: state.namespace,
        transport,
        profilePin,
        ...(Object.keys(initialOwnership).length > 0 ? { initialOwnership } : {}),
        onOwnershipChange: (snap) => {
          state = {
            ...state,
            ownedTargetIds: snap.ownedTargetIds,
            ...(snap.harnessWindowTargetId !== undefined
              ? { harnessWindowTargetId: snap.harnessWindowTargetId }
              : {}),
            ...(snap.harnessWindowId !== undefined
              ? { harnessWindowId: snap.harnessWindowId }
              : {}),
          };
          try { persistState(pi, state); } catch {}
        },
      });
    } else {
      client.setProfilePin(profilePin);
    }

    if (!toolsRegistered) {
      registerAllTools(pi, client);
      toolsRegistered = true;
    }
    registerSetupCommand(pi, client);
    registerProfileCommand(pi, client);
    registerDeepResearchCommand(pi);
  });

  pi.on("session_shutdown", async () => {
    if (client) {
      try {
        await client.detach();
        await client.closeOwnedTabs();
      } catch (e) {
        console.warn("[pi-browser-harness] browser teardown failed during shutdown:", e);
      }
      // Do NOT stop the client or null it out: the surviving daemon connection is what eliminates the per-session "Allow Remote Debugging" prompt.
    }
    persistState(pi, state);
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
