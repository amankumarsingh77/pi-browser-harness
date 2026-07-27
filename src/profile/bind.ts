/**
 * Binding the harness session to a pinned profile.
 *
 * Sequence, all of it verified against a live browser:
 *   1. resolve the browser binary and any explicit --user-data-dir
 *   2. launch a window into the profile, marked with a file:// sentinel
 *   3. poll Target.getTargets for the sentinel page — its browserContextId IS
 *      the profile's context, which is otherwise undiscoverable (CDP exposes no
 *      profile identity)
 *   4. adopt that page as the harness window, blank it, drop the sentinel file
 *
 * If the sentinel never appears the bind FAILS LOUDLY. Falling through to a
 * normal createTarget would put the agent in the focus-derived default profile
 * — the exact bug this feature exists to remove — so the caller gets an
 * actionable error instead.
 *
 * The resolved context id is session-scoped state, never persisted: Chrome
 * mints new context ids on every browser run.
 */

import type { BrowserClient } from "../client";
import { attachTo } from "../cdp/attach";
import type { ResultOf } from "../cdp/commands";
import { type CdpError, cdpError } from "../cdp/errors";
import { getWindowId } from "../cdp/window";
import { type Result, err, ok } from "../util/result";
import { detectRunningBrowser, resolveBrowserExecutable } from "./browser-process";
import { openProfileWindow } from "./launch";
import type { ProfilePin } from "./store";

/** The launch delegates through ProcessSingleton, so allow for a cold profile. */
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

/**
 * Open (and adopt) a harness window inside the pinned profile. Returns the
 * seed tab's target id.
 */
export const seedProfileWindow = async (
  client: BrowserClient,
  pin: ProfilePin,
): Promise<Result<string, CdpError>> => {
  // A pin belongs to one user-data-dir. If the harness is now attached to a
  // different browser, silently seeding the "same" profile name would be wrong.
  const connectedDir = client.userDataDir();
  if (connectedDir && connectedDir !== pin.userDataDir) {
    return err(cdpError(
      "discovery_failed",
      `the selected profile "${pin.label}" belongs to ${pin.userDataDir}, but the harness is connected to ${connectedDir}. ` +
      `Run /browser-profile to choose a profile in the browser you're using.`,
    ));
  }

  // Identify the browser by the dir we're connected to. With several Chromium
  // browsers running, launching into the wrong one would open a window the
  // harness cannot see — in a browser the user never pointed us at.
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
    // Forward the user-data-dir ONLY when the running browser advertises one.
    // ProcessSingleton keys on this path: passing the value the target process
    // itself reports guarantees delegation, whereas supplying a default dir we
    // reconstructed could differ by case or normalisation and start a SECOND
    // browser instead.
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

  // Blank the handshake page so the seed tab behaves like any other fresh tab,
  // then remove the sentinel file. Best-effort: a failure here costs nothing
  // beyond the placeholder page staying visible.
  const attached = await attachTo(client.session(), seed.targetId);
  if (attached.success) {
    await client.session().callOnTarget("Page.navigate", { url: "about:blank" }, attached.data);
  }
  await cleanup();

  return ok(seed.targetId);
};
