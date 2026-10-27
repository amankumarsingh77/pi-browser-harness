import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type BrowserClient, type BrowserClientOptions, createBrowserClient } from "./client";
import { getBrowserSystemPrompt } from "./prompt";
import { registerSetupCommand } from "./setup";
import { registerProfileCommand } from "./profile/command";
import { type ProfilePin, readPin } from "./profile/store";
import { type BrowserState, createStatePersister, restoreState } from "./state";
import { ALL_TOOLS, type RegistryError, createToolRegistry } from "./registry";
import { cleanupTempDirs } from "./util/truncate";
import { restoreDownloadBehavior } from "./domains/files";
import { createDaemonTransport } from "./daemon/transport";
import type { CdpTransport } from "./cdp/types";
import { setDebugClicks } from "./util/debug";
import { asBoolean, asString } from "./util/guards";
import { type BrowserTool, setCallObserver } from "./util/tool";
import type { Result } from "./util/result";
import { activeJournal, createJournal, journalDir, setActiveJournal } from "./recipes/journal";
import { observeCall } from "./recipes/recordable";
import { registerRecipeCommand } from "./recipes/command";

export { defineBrowserTool } from "./util/tool";
export type {
  BrowserTool,
  BrowserToolDefinition,
  DefinedBrowserTool,
  HandlerContext,
  ToolConcurrency,
  ToolErr,
  ToolErrKind,
  ToolHandler,
  ToolOk,
} from "./util/tool";
export type { RegistryError, ToolRegistry } from "./registry";
export type { BrowserClient } from "./client";
export { err, ok } from "./util/result";
export type { Result } from "./util/result";

// One registry per process: pi loads this module once, and another extension that imports it
// shares the same instance, so tools contributed through registerBrowserTools reach the same
// client, mutation mutex and tab ownership as the built-ins.
const harnessRegistry = createToolRegistry(ALL_TOOLS);

// Contribute tools from another pi extension. Call it at that extension's load time, before
// session_start; the tools are registered with pi on the next session_start alongside the
// built-ins. The batch is all-or-nothing: a name clash rejects the whole call and leaves the
// registry untouched.
export const registerBrowserTools = (tools: ReadonlyArray<BrowserTool>): Result<void, RegistryError> =>
  harnessRegistry.addAll(tools);

// The tools the extension will register, built-ins plus contributions so far.
export const browserTools = (): ReadonlyArray<BrowserTool> => harnessRegistry.tools();

// The collaborators session_start reaches for. Each defaults to the real implementation; tests
// inject recorders to observe the namespace handed to the transport and the client's lifetime.
export type ExtensionDeps = {
  readonly createTransport?: (namespace: string) => CdpTransport;
  readonly createClient?: (opts: BrowserClientOptions) => BrowserClient;
  readonly readPin?: () => Promise<ProfilePin | null>;
};

export const createExtension = (deps: ExtensionDeps = {}): ((pi: ExtensionAPI) => void) => (pi: ExtensionAPI): void => {
  const createTransport = deps.createTransport ?? ((namespace: string): CdpTransport => createDaemonTransport(namespace));
  const createClient = deps.createClient ?? createBrowserClient;
  const loadPin = deps.readPin ?? readPin;

  // Flags are only readable once pi has parsed them, which is after registration and before the
  // first session event; reading at load time always yielded undefined (#browser-namespace).
  let namespace: string | undefined;
  const resolveNamespace = (): string => {
    namespace ??= asString(pi.getFlag("browser-namespace")) ?? `pi-${Math.random().toString(36).slice(2, 10)}`;
    return namespace;
  };

  let state: BrowserState | undefined;
  const persister = createStatePersister(pi);
  let client: BrowserClient | null = null;

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
          if (info.data.kind === "dialog") {
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
      const r = await client.start({ reconnectNow: true });
      if (r.success) {
        ctx.ui.notify("Browser client restarted ✓", "info");
      } else {
        ctx.ui.notify(`Restart failed: ${r.error.message}`, "error");
      }
    },
  });

  pi.on("session_start", async (_event, ctx) => {
    const restored = restoreState(ctx, resolveNamespace());
    state = restored;
    persister.markPersisted(restored);
    setDebugClicks(asBoolean(pi.getFlag("browser-debug-clicks")) ?? false);

    // Re-read the on-disk profile pin every session start: another pi session may have changed it since this client was created.
    const profilePin = await loadPin();

    if (!client) {
      const transport = createTransport(restored.namespace);

      const initialOwnership: { ownedTargetIds?: ReadonlyArray<string>; harnessWindowTargetId?: string; harnessWindowId?: number } = {};
      if (restored.ownedTargetIds !== undefined) initialOwnership.ownedTargetIds = restored.ownedTargetIds;
      if (restored.harnessWindowTargetId !== undefined) initialOwnership.harnessWindowTargetId = restored.harnessWindowTargetId;
      if (restored.harnessWindowId !== undefined) initialOwnership.harnessWindowId = restored.harnessWindowId;

      client = createClient({
        namespace: restored.namespace,
        transport,
        profilePin,
        ...(Object.keys(initialOwnership).length > 0 ? { initialOwnership } : {}),
        onOwnershipChange: (snap) => {
          state = {
            ...(state ?? restored),
            ownedTargetIds: snap.ownedTargetIds,
            ...(snap.harnessWindowTargetId !== undefined
              ? { harnessWindowTargetId: snap.harnessWindowTargetId }
              : {}),
            ...(snap.harnessWindowId !== undefined
              ? { harnessWindowId: snap.harnessWindowId }
              : {}),
          };
          try {
            persister.persist(state);
          } catch {
            // Persisting is best-effort: a failed append must not break ownership tracking.
          }
        },
      });
    } else {
      client.setProfilePin(profilePin);
    }

    setActiveJournal(createJournal(journalDir(), ctx.sessionManager.getSessionId()));
    setCallObserver(observeCall);

    harnessRegistry.register(pi, client);
    registerSetupCommand(pi, client);
    registerProfileCommand(pi, client);
    registerRecipeCommand(pi, client);
  });

  pi.on("agent_start", async () => {
    await activeJournal()?.beginRun();
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
        await client.closeOwnedTabs();
      } catch (e) {
        console.warn("[pi-browser-harness] browser teardown failed during shutdown:", e);
      }
      // Do NOT stop the client or null it out: the surviving daemon connection is what eliminates the per-session "Allow Remote Debugging" prompt.
    }
    if (state !== undefined) persister.persist(state);
    await cleanupTempDirs();
  });

  // The branch already holds the restored snapshot: re-appending it only grows the session file.
  pi.on("session_tree", (_event, ctx) => {
    const restored = restoreState(ctx, resolveNamespace());
    state = restored;
    persister.markPersisted(restored);
  });

  pi.on("before_agent_start", (event) => {
    return {
      systemPrompt: event.systemPrompt + getBrowserSystemPrompt(client?.status().alive ?? false, harnessRegistry.tools()),
    };
  });
};

const browserHarnessExtension = createExtension();
export default browserHarnessExtension;
