import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "./client";
import { ensureDaemon } from "./daemon/spawn";
import { DAEMON_SOCKET_PATH } from "./daemon/protocol";
import { type BrowserLocation, locateBrowser } from "./browser-location";
import { promptForProfileIfUnset } from "./profile/command";
import { type Result, err, ok } from "./util/result";

// The machine probes setup runs before touching the client. Each defaults to the real implementation.
export type SetupDeps = {
  readonly locateBrowser?: () => Promise<BrowserLocation>;
  readonly ensureDaemon?: () => Promise<boolean>;
};

export function registerSetupCommand(pi: ExtensionAPI, client: BrowserClient, deps: SetupDeps = {}): void {
  pi.registerCommand("browser-setup", {
    description: "Connect pi to your Chrome browser",
    handler: async (_args, ctx) => {
      const result = await performSetup(client, ctx, deps);
      if (result.success) {
        ctx.ui.notify(result.data, "info");
      } else {
        ctx.ui.notify(result.error, "error");
      }
    },
  });
}

export type SetupResult = Result<string, string>;

export async function performSetup(
  client: BrowserClient,
  ctx?: ExtensionContext,
  deps: SetupDeps = {},
): Promise<SetupResult> {
  // Reachability decides whether setup can proceed; a browser process on this machine is not required (it may sit behind a tunnel, on the Windows host of a WSL session, or in a container).
  const location = await (deps.locateBrowser ?? locateBrowser)();
  if (location.kind === "none") {
    return err(
      "No browser found. Open your browser and run /browser-setup.\n\n" +
        "If the browser runs on another machine (the Windows host from WSL, an SSH tunnel, a container),\n" +
        "make its DevTools port reachable on 127.0.0.1:9222 or set BU_CDP_WS to its WebSocket URL.",
    );
  }

  const daemonReady = await (deps.ensureDaemon ?? ensureDaemon)();
  if (!daemonReady) {
    return err(`Could not start the browser daemon. Check ${DAEMON_SOCKET_PATH}.`);
  }

  // Profiles live on the browser's own disk, so there is nothing to list or pin for a remote one.
  const profileNote = location.kind === "remote"
    ? "Remote browser: profile selection is unavailable, using whichever window is focused."
    : await promptForProfileIfUnset(client, ctx);

  const startResult = await client.start({ reconnectNow: true });
  if (!startResult.success) {
    const msg = startResult.error.message;
    const lower = msg.toLowerCase();

    if (
      lower.includes("devtoolsactiveport") ||
      lower.includes("remote debugging") ||
      lower.includes("econnrefused") ||
      lower.includes("cannot reach chrome devtools")
    ) {
      return err(
        "Browser remote debugging needs to be enabled.\n\n" +
          "Open chrome://inspect/#remote-debugging (or brave://inspect,\n" +
          "edge://inspect) in your browser, tick the\n" +
          '"Discover network targets" / Allow checkbox, then retry.\n\n' +
          "If that doesn't expose DevTools, relaunch the browser with\n" +
          "--remote-debugging-port=9222.\n\n" +
          "Or set BU_CDP_WS to a remote browser WebSocket URL.",
      );
    }

    return err(`Connection failed: ${msg}`);
  }

  const tabResult = await client.newTab("https://github.com");
  if (!tabResult.success) {
    return err(`Browser connected but test navigation failed: ${tabResult.error.message}`);
  }

  const info = await client.pageInfo();
  if (info.success && info.data.kind === "dialog") {
    await client.session().call("Page.handleJavaScriptDialog", { accept: true });
  }

  const pageUrl = info.success && info.data.kind === "page" ? info.data.url : "github.com";
  const lines = ["Browser connected ✓", `Navigated to: ${pageUrl}`];
  if (profileNote) lines.push(profileNote);
  return ok(lines.join("\n"));
}

