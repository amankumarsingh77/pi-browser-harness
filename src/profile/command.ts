import type { ExtensionAPI, ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "../client";
import { discoverEndpoint } from "../cdp/discovery";
import { type Result, err, ok } from "../util/result";
import { type BrowserProfile, listProfiles } from "./list";
import { browserNameForUserDataDir, userDataDirCandidates } from "./paths";
import { clearPin, type ProfilePin, readPin, writePin } from "./store";

// `ctx.ui.select` resolves to undefined both on Escape and in non-interactive modes, so "no answer" must mean "change nothing".

const CLEAR_SELECTION_LABEL = "— Clear selection (use whichever window is focused) —";

type ProfileChoice =
  | { readonly kind: "profile"; readonly profile: BrowserProfile }
  | { readonly kind: "clear" }
  | { readonly kind: "cancelled" };

const disambiguate = (profiles: ReadonlyArray<BrowserProfile>): ReadonlyArray<string> => {
  const counts = new Map<string, number>();
  for (const p of profiles) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
  return profiles.map((p) => ((counts.get(p.label) ?? 0) > 1 ? `${p.label} [${p.dir}]` : p.label));
};

const promptForProfile = async (
  ctx: ExtensionContext,
  profiles: ReadonlyArray<BrowserProfile>,
  currentPin: ProfilePin | null,
  title = "Select browser profile",
): Promise<ProfileChoice> => {
  if (!ctx.hasUI || profiles.length === 0) return { kind: "cancelled" };

  const labels = disambiguate(profiles);
  const rows = labels.map((label, i) => {
    const isPinned = currentPin?.profileDir === profiles[i]?.dir;
    return isPinned ? `✓ ${label}` : `  ${label}`;
  });
  const options = [...rows, CLEAR_SELECTION_LABEL];

  const answer = await ctx.ui.select(title, options);
  if (answer === undefined) return { kind: "cancelled" };
  if (answer === CLEAR_SELECTION_LABEL) return { kind: "clear" };

  const index = options.indexOf(answer);
  const profile = index >= 0 ? profiles[index] : undefined;
  if (!profile) return { kind: "cancelled" };
  return { kind: "profile", profile };
};

const pinFor = (userDataDir: string, profile: BrowserProfile): ProfilePin => ({
  userDataDir,
  profileDir: profile.dir,
  label: profile.label,
  savedAt: new Date().toISOString(),
});

const resolveUserDataDir = async (client: BrowserClient): Promise<Result<string, string>> => {
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
