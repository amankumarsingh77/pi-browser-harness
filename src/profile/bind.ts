
import type { BrowserClient } from "../client";
import { attachTo } from "../cdp/attach";
import type { ResultOf } from "../cdp/commands";
import { type CdpError, cdpError } from "../cdp/errors";
import { getWindowId } from "../cdp/window";
import { type Result, err, ok } from "../util/result";
import { detectRunningBrowser, resolveBrowserExecutable } from "./browser-process";
import { openProfileWindow } from "./launch";
import type { ProfilePin } from "./store";

const SEED_DEADLINE_MS = 15_000;
const SEED_POLL_MS = 500;

type PageTarget = ResultOf<"Target.getTargets">["targetInfos"][number];

const pageTargets = async (client: BrowserClient): Promise<ReadonlyArray<PageTarget>> => {
  const r = await client.session().callBrowser("Target.getTargets");
  if (!r.success) return [];
  return r.data.targetInfos.filter((t) => t.type === "page");
};

const manualFallbackHint = (pin: ProfilePin): string =>
  `open a window for "${pin.label}" yourself (browser profile menu → ${pin.profileDir}), then retry. ` +
  `Run /browser-profile to pick a different profile, or clear the selection to use whichever window is focused.`;

export const seedProfileWindow = async (
  client: BrowserClient,
  pin: ProfilePin,
): Promise<Result<string, CdpError>> => {
  const connectedDir = client.userDataDir();
  if (connectedDir && connectedDir !== pin.userDataDir) {
    return err(cdpError(
      "discovery_failed",
      `the selected profile "${pin.label}" belongs to ${pin.userDataDir}, but the harness is connected to ${connectedDir}. ` +
      `Run /browser-profile to choose a profile in the browser you're using.`,
    ));
  }

  const targetUserDataDir = connectedDir ?? pin.userDataDir;
  const running = await detectRunningBrowser(targetUserDataDir);
  const exePath = await resolveBrowserExecutable(running);
  if (!exePath) {
    return err(cdpError(
      "discovery_failed",
      `could not locate the browser executable needed to open "${pin.label}" — ${manualFallbackHint(pin)}`,
    ));
  }

  const launched = await openProfileWindow({
    exePath,
    profileDir: pin.profileDir,
    // ProcessSingleton keys on the user-data-dir path, so forward only the value the running browser reports: a reconstructed one may differ by case and start a SECOND browser.
    ...(running.explicitUserDataDir ? { explicitUserDataDir: running.explicitUserDataDir } : {}),
  });
  if (!launched.success) {
    return err(cdpError("discovery_failed", `${launched.error} — ${manualFallbackHint(pin)}`));
  }

  const { sentinelUrl, cleanup, kill } = launched.data;
  const deadline = Date.now() + SEED_DEADLINE_MS;
  let seed: PageTarget | undefined;
  while (Date.now() < deadline && !seed) {
    await new Promise((r) => setTimeout(r, SEED_POLL_MS));
    seed = (await pageTargets(client)).find((t) => t.url === sentinelUrl);
  }

  if (!seed) {
    kill();
    await cleanup();
    return err(cdpError(
      "timeout",
      `couldn't open a window in "${pin.label}" automatically — ${manualFallbackHint(pin)}`,
    ));
  }

  // The sentinel's context is the profile's context — the only way to learn it.
  if (seed.browserContextId) client.setProfileContextId(seed.browserContextId);

  const ownership = client.ownership();
  ownership.setHarnessWindow(seed.targetId);
  ownership.add(seed.targetId);
  const win = await getWindowId(client.session(), seed.targetId);
  if (win.success) ownership.setHarnessWindowId(win.data);

  const attached = await attachTo(client.session(), seed.targetId);
  if (attached.success) {
    await client.session().callOnTarget("Page.navigate", { url: "about:blank" }, attached.data);
  }
  await cleanup();

  return ok(seed.targetId);
};
