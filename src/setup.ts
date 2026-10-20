import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "./client";
import { ensureDaemon } from "./daemon/spawn";
import { DAEMON_SOCKET_PATH } from "./daemon/protocol";
import { isBrowserRunning } from "./profile/browser-process";
import { promptForProfileIfUnset } from "./profile/command";
import { type Result, err, ok } from "./util/result";

// The machine probes setup runs before touching the client. Each defaults to the real implementation.
export type SetupDeps = {
  readonly isBrowserRunning?: () => Promise<boolean>;
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
  const chromeRunning = await (deps.isBrowserRunning ?? isBrowserRunning)();
  if (!chromeRunning) {
    return err("No browser instance running. Please open your browser and then run /browser-setup.");
  }

  const daemonReady = await (deps.ensureDaemon ?? ensureDaemon)();
  if (!daemonReady) {
    return err(`Could not start the browser daemon. Check ${DAEMON_SOCKET_PATH}.`);
  }

  const profileNote = await promptForProfileIfUnset(client, ctx);

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

