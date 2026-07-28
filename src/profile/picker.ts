// `ctx.ui.select` resolves to undefined both on Escape and in non-interactive modes, so "no answer" must mean "change nothing".

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BrowserProfile } from "./list";
import type { ProfilePin } from "./store";

export const CLEAR_SELECTION_LABEL = "— Clear selection (use whichever window is focused) —";

export type ProfileChoice =
  | { readonly kind: "profile"; readonly profile: BrowserProfile }
  | { readonly kind: "clear" }
  | { readonly kind: "cancelled" };

const disambiguate = (profiles: ReadonlyArray<BrowserProfile>): ReadonlyArray<string> => {
  const counts = new Map<string, number>();
  for (const p of profiles) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
  return profiles.map((p) => ((counts.get(p.label) ?? 0) > 1 ? `${p.label} [${p.dir}]` : p.label));
};

export const promptForProfile = async (
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

export const pinFor = (userDataDir: string, profile: BrowserProfile): ProfilePin => ({
  userDataDir,
  profileDir: profile.dir,
  label: profile.label,
  savedAt: new Date().toISOString(),
});
