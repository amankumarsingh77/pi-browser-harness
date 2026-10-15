import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type BrowserClient, createBrowserClient } from "./client";
import { getBrowserSystemPrompt } from "./prompt";
import { registerSetupCommand } from "./setup";
import { registerProfileCommand } from "./profile/command";
import { readPin } from "./profile/store";
import { type BrowserState, createStatePersister, defaultState, restoreState } from "./state";
import { registerAllTools } from "./registry";
import { cleanupTempDirs } from "./util/truncate";
import { restoreDownloadBehavior } from "./domains/files";
import { createDaemonTransport } from "./daemon/transport";
import { setDebugClicks } from "./util/debug";
import { asBoolean, asString } from "./util/guards";
import { createVirtualCursorController } from "./cursor/controller";
import type { VirtualCursorController } from "./cursor/types";

export type BrowserHarnessDependencies = {
  readonly createClient?: typeof createBrowserClient;
  readonly createTransport?: typeof createDaemonTransport;
  readonly createCursor?: typeof createVirtualCursorController;
  readonly readProfilePin?: typeof readPin;
  readonly registerTools?: typeof registerAllTools;
  readonly registerSetup?: typeof registerSetupCommand;
  readonly registerProfile?: typeof registerProfileCommand;
  readonly cleanupTempDirectories?: typeof cleanupTempDirs;
};

export function createBrowserHarnessExtension(
  pi: ExtensionAPI,
  dependencies: BrowserHarnessDependencies = {},
): void {
  const createClient = dependencies.createClient ?? createBrowserClient;
  const createTransport = dependencies.createTransport ?? createDaemonTransport;
  const createCursor = dependencies.createCursor ?? createVirtualCursorController;
  const readProfilePin = dependencies.readProfilePin ?? readPin;
  const registerTools = dependencies.registerTools ?? registerAllTools;
  const registerSetup = dependencies.registerSetup ?? registerSetupCommand;
  const registerProfile = dependencies.registerProfile ?? registerProfileCommand;
  const cleanupTempDirectories = dependencies.cleanupTempDirectories ?? cleanupTempDirs;
  const flagNs = asString(pi.getFlag("browser-namespace"));
  const namespace = flagNs ?? `pi-${Math.random().toString(36).slice(2, 10)}`;

  let state: BrowserState = defaultState(namespace);
  const persister = createStatePersister(pi);
  let client: BrowserClient | null = null;
  let cursor: VirtualCursorController | null = null;
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
  pi.registerFlag("no-browser-cursor", {
    description: "Disable the in-page virtual cursor for this process",
    type: "boolean",
    default: false,
  });

  pi.registerCommand("browser-cursor", {
    description: "Control the in-page virtual cursor: on, off, or status",
    handler: async (args, ctx) => {
      if (!cursor) {
        ctx.ui.notify("Browser client not started. Run /browser-setup first.", "warning");
        return;
      }
      const mode = args.trim().toLowerCase();
      const forcedOff = asBoolean(pi.getFlag("no-browser-cursor")) ?? false;
      if (mode === "on") {
        if (forcedOff) {
          ctx.ui.notify("Virtual cursor: forced off by --no-browser-cursor", "warning");
          return;
        }
        await cursor.applySessionSettings(true);
        state = { ...state, cursorEnabled: true };
        persister.persist(state);
        ctx.ui.notify("Virtual cursor: on", "info");
        return;
      }
      if (mode === "off") {
        await cursor.applySessionSettings(false);
        state = { ...state, cursorEnabled: false };
        persister.persist(state);
        ctx.ui.notify("Virtual cursor: off", "info");
        return;
      }
      if (mode === "status") {
        const status = cursor.status();
        if (forcedOff) {
          ctx.ui.notify("Virtual cursor: forced off by --no-browser-cursor", "info");
        } else if (status.diagnostics.status === "degraded") {
          ctx.ui.notify(`Virtual cursor: degraded (${status.diagnostics.reason ?? "unknown reason"})`, "warning");
        } else {
          ctx.ui.notify(`Virtual cursor: ${status.enabled ? "on" : "off"}`, "info");
        }
        return;
      }
      ctx.ui.notify("Usage: /browser-cursor on|off|status", "warning");
    },
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
    persister.markPersisted(state);
    setDebugClicks(asBoolean(pi.getFlag("browser-debug-clicks")) ?? false);

    // Re-read the on-disk profile pin every session start: another pi session may have changed it since this client was created.
    const profilePin = await readProfilePin();

    if (!client) {
      const transport = createTransport(state.namespace);

      const initialOwnership: { ownedTargetIds?: ReadonlyArray<string>; harnessWindowTargetId?: string; harnessWindowId?: number } = {};
      if (state.ownedTargetIds !== undefined) initialOwnership.ownedTargetIds = state.ownedTargetIds;
      if (state.harnessWindowTargetId !== undefined) initialOwnership.harnessWindowTargetId = state.harnessWindowTargetId;
      if (state.harnessWindowId !== undefined) initialOwnership.harnessWindowId = state.harnessWindowId;

      client = createClient({
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
          try { persister.persist(state); } catch {}
        },
      });
      cursor = createCursor(client, {
        enabled: !(asBoolean(pi.getFlag("no-browser-cursor")) ?? false),
      });
    } else {
      client.setProfilePin(profilePin);
    }

    if (!cursor) throw new Error("virtual cursor was not initialized");
    await cursor.applySessionSettings(
      (asBoolean(pi.getFlag("no-browser-cursor")) ?? false) ? false : state.cursorEnabled ?? true,
    );

    if (!toolsRegistered) {
      registerTools(pi, client, cursor);
      toolsRegistered = true;
    }
    registerSetup(pi, client);
    registerProfile(pi, client);
  });

  pi.on("session_shutdown", async () => {
    if (client) {
      try {
        // Warn but keep going: detach and tab cleanup still have to run, and a throw here would skip both.
        const restored = await restoreDownloadBehavior(client);
        if (!restored.success) {
          console.warn(`[pi-browser-harness] ${restored.error.message}`);
        }
        await client.detach();
      } catch (e) {
        console.warn("[pi-browser-harness] browser teardown failed during shutdown:", e);
      }
      try {
        await client.closeOwnedTabs();
      } catch (e) {
        console.warn("[pi-browser-harness] browser teardown failed during shutdown:", e);
      } finally {
        await cursor?.clear();
      }
      // Do NOT stop the client or null it out: the surviving daemon connection is what eliminates the per-session "Allow Remote Debugging" prompt.
    }
    persister.persist(state);
    await cleanupTempDirectories();
  });

  // The branch already holds the restored snapshot: re-appending it only grows the session file.
  pi.on("session_tree", async (_event, ctx) => {
    state = restoreState(ctx, client?.namespace);
    persister.markPersisted(state);
    await cursor?.applySessionSettings(
      (asBoolean(pi.getFlag("no-browser-cursor")) ?? false) ? false : state.cursorEnabled ?? true,
    );
  });

  pi.on("before_agent_start", async (event) => {
    return {
      systemPrompt: event.systemPrompt + getBrowserSystemPrompt(client?.status().alive ?? false),
    };
  });
}

export default function browserHarnessExtension(pi: ExtensionAPI): void {
  createBrowserHarnessExtension(pi);
}
