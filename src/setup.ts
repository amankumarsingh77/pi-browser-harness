import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "./client";
import { ensureDaemon } from "./daemon/spawn";
import { DAEMON_SOCKET_PATH } from "./daemon/protocol";
import { type BrowserLocation, locateBrowser } from "./browser-location";
import { promptForProfileIfUnset } from "./profile/command";
import { type InstalledBrowser, chooseBrowserToLaunch, installedBrowsers } from "./profile/installed";
import { type BrowserLaunchRequest, launchBrowser } from "./profile/launch";
import { type ProfilePin, readPin } from "./profile/store";
import { sleep } from "./util/sleep";
import { type Result, err, ok } from "./util/result";

// The machine probes setup runs before touching the client. Each defaults to the real implementation.
export type SetupDeps = {
  readonly locateBrowser?: () => Promise<BrowserLocation>;
  readonly ensureDaemon?: () => Promise<boolean>;
  // Opening a browser that is closed.
  readonly installedBrowsers?: () => Promise<ReadonlyArray<InstalledBrowser>>;
  readonly launchBrowser?: (req: BrowserLaunchRequest) => Promise<Result<void, string>>;
  readonly readPin?: () => Promise<ProfilePin | null>;
  readonly canShowWindow?: () => boolean;
  readonly sleep?: (ms: number) => Promise<void>;
  readonly now?: () => number;
  readonly launchWaitMs?: number;
  readonly launchPollMs?: number;
};

const NO_BROWSER =
  "No browser found. Open your browser and run /browser-setup.\n\n" +
  "If the browser runs on another machine (the Windows host from WSL, an SSH tunnel, a container),\n" +
  "make its DevTools port reachable on 127.0.0.1:9222 or set BU_CDP_WS to its WebSocket URL.";

const LAUNCH_WAIT_MS = 15_000;
const LAUNCH_POLL_MS = 500;
// How long a browser that is up but has no DevTools endpoint is given before concluding remote debugging is simply off.
const DEBUGGING_OFF_GRACE_MS = 5_000;

// A Linux session with neither X nor Wayland (SSH, a container, CI) cannot show a browser window.
const hasDisplay = (): boolean =>
  process.platform !== "linux" || Boolean(process.env["DISPLAY"]) || Boolean(process.env["WAYLAND_DISPLAY"]);

type OpenedBrowser = { readonly location: BrowserLocation; readonly family: string };

// Opens the user's own browser when none is running. It restores their windows and tabs, so it is never a surprise:
// with a UI the user is asked; without one only a saved profile pin, which already says which browser to use, is enough.
const openClosedBrowser = async (
  client: BrowserClient,
  ctx: ExtensionContext | undefined,
  deps: SetupDeps,
): Promise<Result<OpenedBrowser, string>> => {
  if (!(deps.canShowWindow ?? hasDisplay)()) return err(NO_BROWSER);

  const pin = client.profilePin() ?? (await (deps.readPin ?? readPin)());
  const installed = await (deps.installedBrowsers ?? installedBrowsers)();
  const browser = chooseBrowserToLaunch(installed, pin?.userDataDir);
  if (!browser) {
    return err(
      installed.length > 1 && !pin
        ? `${NO_BROWSER}\n\nMore than one browser is installed (${installed.map((b) => b.family).join(", ")}), so none was opened for you.`
        : NO_BROWSER,
    );
  }

  if (ctx?.hasUI) {
    const profile = pin ? ` in the profile "${pin.label}"` : "";
    const agreed = await ctx.ui.confirm(
      `Open ${browser.family}?`,
      `No browser is running. pi can open ${browser.family}${profile} for you; your windows and tabs come back as you left them.`,
    );
    if (!agreed) return err(NO_BROWSER);
  } else if (!pin) {
    return err(NO_BROWSER);
  }

  const launched = await (deps.launchBrowser ?? launchBrowser)({
    exePath: browser.exePath,
    ...(pin ? { profileDir: pin.profileDir } : {}),
  });
  if (!launched.success) return err(`Could not open ${browser.family}: ${launched.error}`);

  // Both limits are measured in elapsed time, not poll counts: a lookup scans processes and can itself take seconds.
  const pause = deps.sleep ?? sleep;
  const now = deps.now ?? Date.now;
  const pollMs = deps.launchPollMs ?? LAUNCH_POLL_MS;
  const deadline = now() + (deps.launchWaitMs ?? LAUNCH_WAIT_MS);
  let location: BrowserLocation = { kind: "none" };
  let upSince: number | undefined;
  while (now() < deadline) {
    await pause(pollMs);
    location = await (deps.locateBrowser ?? locateBrowser)();
    if (location.kind === "none") continue;
    if (location.endpoint) break;
    upSince ??= now();
    if (now() - upSince >= DEBUGGING_OFF_GRACE_MS) break;
  }
  if (location.kind === "none") {
    return err(`Opened ${browser.family}, but it did not start. Open it yourself, then run /browser-setup.`);
  }
  // Setup started this browser here, so it is local even if the process scan has not caught up with it.
  return ok({ location: location.endpoint ? { kind: "local", endpoint: location.endpoint } : { kind: "local" }, family: browser.family });
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
  let location = await (deps.locateBrowser ?? locateBrowser)();
  let openedNote: string | undefined;
  if (location.kind === "none") {
    const opened = await openClosedBrowser(client, ctx, deps);
    if (!opened.success) return opened;
    location = opened.data.location;
    openedNote = `Opened ${opened.data.family}.`;
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
  const lines = [...(openedNote ? [openedNote] : []), "Browser connected ✓", `Navigated to: ${pageUrl}`];
  if (profileNote) lines.push(profileNote);
  return ok(lines.join("\n"));
}

