/**
 * /browser-profile — choose which browser profile the agent works in.
 *
 * The selection is durable (see store.ts) and applies immediately: the current
 * harness tabs are closed and a new window is opened in the chosen profile, so
 * the agent's next action happens where the user just asked for it rather than
 * one session later.
 */

import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "../client";
import { discoverEndpoint } from "../cdp/discovery";
import { type Result, err, ok } from "../util/result";
import { type BrowserProfile, listProfiles } from "./list";
import { browserNameForUserDataDir, userDataDirCandidates } from "./paths";
import { pinFor, promptForProfile } from "./picker";
import { clearPin, readPin, writePin } from "./store";

/**
 * Which user-data-dir the picker should enumerate: the connected browser's
 * when known, otherwise a running browser's, otherwise the only installed one
 * that actually has profiles.
 */
export const resolveUserDataDir = async (client: BrowserClient): Promise<Result<string, string>> => {
  const connected = client.userDataDir();
  if (connected) return ok(connected);

  const endpoint = await discoverEndpoint();
  if (endpoint.success && endpoint.data.userDataDir) return ok(endpoint.data.userDataDir);

  const withProfiles: string[] = [];
  for (const dir of userDataDirCandidates()) {
    if ((await listProfiles(dir)).length > 0) withProfiles.push(dir);
  }
  const only = withProfiles[0];
  if (withProfiles.length === 1 && only !== undefined) return ok(only);
  if (withProfiles.length === 0) {
    return err("No browser profiles found on this machine. Open Chrome, Brave, or Edge and try again.");
  }
  return err(
    `Found profiles for more than one browser (${withProfiles.map(browserNameForUserDataDir).join(", ")}). ` +
    "Open the browser you want the agent to use, then run /browser-profile again.",
  );
};

/** Enumerate profiles for the resolved dir, or explain why we cannot. */
const loadProfiles = async (
  client: BrowserClient,
): Promise<Result<{ userDataDir: string; profiles: ReadonlyArray<BrowserProfile> }, string>> => {
  const dir = await resolveUserDataDir(client);
  if (!dir.success) return dir;
  const profiles = await listProfiles(dir.data);
  if (profiles.length === 0) {
    return err(`No profiles found in ${dir.data}. If the browser was just installed, open it once and retry.`);
  }
  return ok({ userDataDir: dir.data, profiles });
};

/**
 * Re-seed the live session so the new profile takes effect now. Closing the
 * owned tabs and restarting the client makes start() open a window in the
 * pinned profile and attach to it.
 */
const applyToLiveSession = async (client: BrowserClient): Promise<Result<void, string>> => {
  if (!client.status().alive) return ok(undefined);
  await client.closeOwnedTabs();
  await client.stop();
  const started = await client.start();
  if (!started.success) return err(started.error.message);
  return ok(undefined);
};

export function registerProfileCommand(pi: ExtensionAPI, client: BrowserClient): void {
  pi.registerCommand("browser-profile", {
    description: "Choose which browser profile the agent uses",
    handler: async (_args, ctx) => {
      const loaded = await loadProfiles(client);
      if (!loaded.success) {
        ctx.ui.notify(loaded.error, "error");
        return;
      }
      if (!ctx.hasUI) {
        ctx.ui.notify("Profile selection needs an interactive terminal.", "warning");
        return;
      }

      const currentPin = client.profilePin() ?? (await readPin());
      const choice = await promptForProfile(ctx, loaded.data.profiles, currentPin);

      if (choice.kind === "cancelled") {
        ctx.ui.notify("Profile unchanged.", "info");
        return;
      }

      if (choice.kind === "clear") {
        const cleared = await clearPin();
        if (!cleared.success) {
          ctx.ui.notify(cleared.error, "error");
          return;
        }
        client.setProfilePin(null);
        ctx.ui.notify(
          "Profile selection cleared. New windows will open in whichever browser profile is focused.",
          "info",
        );
        return;
      }

      const pin = pinFor(loaded.data.userDataDir, choice.profile);
      const saved = await writePin(pin);
      if (!saved.success) {
        ctx.ui.notify(saved.error, "error");
        return;
      }
      client.setProfilePin(pin);

      const applied = await applyToLiveSession(client);
      if (!applied.success) {
        ctx.ui.notify(
          `Saved ${pin.label}, but switching the open session failed: ${applied.error}`,
          "warning",
        );
        return;
      }
      ctx.ui.notify(`Browser profile: ${pin.label} ✓\nSaved — this profile is used until you change it.`, "info");
    },
  });
}

/**
 * First-run prompt used by setup: pick a profile when none is pinned yet.
 * Returns a note to append to the setup output; the caller always continues,
 * because a cancelled or unavailable picker must leave existing behavior intact.
 */
export const promptForProfileIfUnset = async (
  client: BrowserClient,
  ctx: ExtensionContext | undefined,
): Promise<string | undefined> => {
  if (client.profilePin()) return undefined;

  const stored = await readPin();
  if (stored) {
    client.setProfilePin(stored);
    return undefined;
  }
  if (!ctx?.hasUI) {
    return "No browser profile selected — using whichever window is focused. Run /browser-profile to pin one.";
  }

  const loaded = await loadProfiles(client);
  if (!loaded.success) return loaded.error;

  const choice = await promptForProfile(
    ctx,
    loaded.data.profiles,
    null,
    "Select the browser profile the agent should use",
  );
  if (choice.kind !== "profile") {
    return "No browser profile selected — using whichever window is focused. Run /browser-profile to pin one.";
  }

  const pin = pinFor(loaded.data.userDataDir, choice.profile);
  const saved = await writePin(pin);
  if (!saved.success) return saved.error;
  client.setProfilePin(pin);
  return `Browser profile: ${pin.label}`;
};
