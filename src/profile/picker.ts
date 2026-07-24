/**
 * The profile picker, shared by /browser-profile and first-run setup so both
 * show the user exactly the same list.
 *
 * Rendering rules:
 *   - one row per profile, labelled "Name (email)" — or "Name (Profile 3)" when
 *     the profile has no signed-in account, so every row keeps its shape
 *   - the pinned profile is marked with a check
 *   - a final row clears the selection, since a pin must be undoable
 *
 * `ctx.ui.select` resolves to undefined when the user presses Escape AND in
 * non-interactive modes (pi's print/RPC UI context returns undefined for every
 * dialog), so callers must treat "no answer" as "change nothing".
 */

import type { ExtensionContext } from "@mariozechner/pi-coding-agent";
import type { BrowserProfile } from "./list";
import type { ProfilePin } from "./store";

export const CLEAR_SELECTION_LABEL = "— Clear selection (use whichever window is focused) —";

export type ProfileChoice =
  | { readonly kind: "profile"; readonly profile: BrowserProfile }
  | { readonly kind: "clear" }
  | { readonly kind: "cancelled" };

/**
 * Two profiles can legitimately share a name and account (the same person
 * signed into two profiles). Labels must stay distinct or the selection cannot
 * be mapped back, so a repeated label gains its directory.
 */
const disambiguate = (profiles: ReadonlyArray<BrowserProfile>): ReadonlyArray<string> => {
  const counts = new Map<string, number>();
  for (const p of profiles) counts.set(p.label, (counts.get(p.label) ?? 0) + 1);
  return profiles.map((p) => ((counts.get(p.label) ?? 0) > 1 ? `${p.label} [${p.dir}]` : p.label));
};

/**
 * Show the picker and report what the user chose. Returns "cancelled" when
 * there is no UI or the user dismissed the dialog.
 */
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

/** Build the durable pin for a chosen profile. */
export const pinFor = (userDataDir: string, profile: BrowserProfile): ProfilePin => ({
  userDataDir,
  profileDir: profile.dir,
  label: profile.label,
  savedAt: new Date().toISOString(),
});
