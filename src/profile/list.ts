/**
 * Browser profile enumeration.
 *
 * A Chromium user-data-dir registers its profiles in `Local State` under the
 * JSON key `profile.info_cache`, with `profile.profiles_order` giving the
 * user's own ordering and `profile.last_used` naming the active one. Those
 * keys are declared in Chromium's pref_names.h with no platform BUILDFLAG, so
 * the layout is identical on Linux, macOS, and Windows (the C++ constant is
 * now `kProfileAttributes`; the on-disk key never changed).
 *
 * Enumeration is two-tier so a Chromium fork or a future schema change cannot
 * blank the list:
 *   tier 1 — `Local State` → `profile.info_cache` (authoritative: display
 *            names, accounts, ordering)
 *   tier 2 — scan subdirectories holding a `Preferences` file and read
 *            `profile.name` + `account_info[0].email`
 *
 * Nothing here throws: an unreadable or malformed file yields an empty list so
 * callers degrade to the harness's pre-existing behavior.
 */

import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

export type BrowserProfile = {
  /** Profile subdirectory name, e.g. "Default" or "Profile 1". */
  readonly dir: string;
  /** Display name as shown in the browser's profile menu. */
  readonly name: string;
  /** Signed-in account address, when the profile has one. */
  readonly email?: string;
  /** Picker label — "Name (email)", or "Name (dir)" with no account. */
  readonly label: string;
  /** True for the profile the browser reports as last used. */
  readonly lastUsed: boolean;
};

/** Directories inside a user-data-dir that are not user profiles. */
const NON_PROFILE_DIRS: ReadonlySet<string> = new Set([
  "System Profile",
  "Guest Profile",
]);

/**
 * Picker label. The bracketed half is the account address when there is one,
 * and the profile directory otherwise, so every row keeps the same shape.
 */
export const formatProfileLabel = (name: string, email: string | undefined, dir: string): string =>
  `${name} (${email && email.length > 0 ? email : dir})`;

const readJsonFile = async (path: string): Promise<Record<string, unknown> | null> => {
  try {
    const raw = await readFile(path, "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return null;
    return parsed as Record<string, unknown>;
  } catch {
    // Missing file, permission error, or malformed JSON — the caller falls
    // back to the next tier, and ultimately to an empty list.
    return null;
  }
};

const asRecord = (v: unknown): Record<string, unknown> | null =>
  typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Record<string, unknown>) : null;

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

/**
 * Order profiles the way the browser does: `profiles_order` first (in its own
 * sequence), then anything unlisted, alphabetically.
 */
const orderDirs = (dirs: ReadonlyArray<string>, order: ReadonlyArray<string>): ReadonlyArray<string> => {
  const known = order.filter((d) => dirs.includes(d));
  const rest = dirs.filter((d) => !known.includes(d)).sort((a, b) => a.localeCompare(b));
  return [...known, ...rest];
};

const buildProfile = (
  dir: string,
  name: string | undefined,
  email: string | undefined,
  lastUsed: boolean,
): BrowserProfile => {
  const displayName = name ?? dir;
  return {
    dir,
    name: displayName,
    ...(email !== undefined ? { email } : {}),
    label: formatProfileLabel(displayName, email, dir),
    lastUsed,
  };
};

/** Tier 1 — `Local State` → `profile.info_cache`. */
const listFromLocalState = async (userDataDir: string): Promise<ReadonlyArray<BrowserProfile>> => {
  const localState = await readJsonFile(join(userDataDir, "Local State"));
  if (!localState) return [];
  const profileNode = asRecord(localState["profile"]);
  if (!profileNode) return [];
  const infoCache = asRecord(profileNode["info_cache"]);
  if (!infoCache) return [];

  const rawOrder = profileNode["profiles_order"];
  const order = Array.isArray(rawOrder) ? rawOrder.filter((v): v is string => typeof v === "string") : [];
  const lastUsed = asString(profileNode["last_used"]);

  const entries: Array<{ dir: string; entry: Record<string, unknown> }> = [];
  for (const [dir, value] of Object.entries(infoCache)) {
    if (NON_PROFILE_DIRS.has(dir)) continue;
    const entry = asRecord(value);
    if (!entry) continue;
    // Ephemeral (guest-like) profiles vanish when their window closes — never
    // offer one as a durable pin.
    if (entry["is_ephemeral"] === true) continue;
    entries.push({ dir, entry });
  }

  const ordered = orderDirs(entries.map((e) => e.dir), order);
  const byDir = new Map(entries.map((e) => [e.dir, e.entry]));

  return ordered.flatMap((dir) => {
    const entry = byDir.get(dir);
    if (!entry) return [];
    // `name` is the user-visible profile name; `gaia_name` is the Google
    // account's own display name and is the better fallback when a profile
    // still carries an auto-generated name like "Person 1".
    const name = asString(entry["name"]) ?? asString(entry["gaia_name"]);
    const email = asString(entry["user_name"]);
    return [buildProfile(dir, name, email, dir === lastUsed)];
  });
};

/** Tier 2 — directory scan, reading each profile's own `Preferences`. */
const listFromPreferencesScan = async (userDataDir: string): Promise<ReadonlyArray<BrowserProfile>> => {
  let dirents;
  try {
    dirents = await readdir(userDataDir, { withFileTypes: true });
  } catch {
    return [];
  }

  const candidates = dirents
    .filter((d) => d.isDirectory() && !NON_PROFILE_DIRS.has(d.name))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));

  const profiles: BrowserProfile[] = [];
  for (const dir of candidates) {
    const prefs = await readJsonFile(join(userDataDir, dir, "Preferences"));
    if (!prefs) continue; // not a profile directory
    const profileNode = asRecord(prefs["profile"]);
    const name = profileNode ? asString(profileNode["name"]) : undefined;
    const accounts = prefs["account_info"];
    const firstAccount = Array.isArray(accounts) ? asRecord(accounts[0]) : null;
    const email = firstAccount ? asString(firstAccount["email"]) : undefined;
    profiles.push(buildProfile(dir, name, email, false));
  }
  return profiles;
};

/**
 * Every selectable profile in a user-data-dir, best-effort. Returns an empty
 * array when the directory is unreadable or holds no profiles.
 */
export const listProfiles = async (userDataDir: string): Promise<ReadonlyArray<BrowserProfile>> => {
  const fromLocalState = await listFromLocalState(userDataDir);
  if (fromLocalState.length > 0) return fromLocalState;
  return listFromPreferencesScan(userDataDir);
};
