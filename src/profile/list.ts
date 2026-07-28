import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { parseJson } from "../schemas/parse";

export type BrowserProfile = {
  readonly dir: string;
  readonly name: string;
  readonly email?: string;
  readonly label: string;
  readonly lastUsed: boolean;
};

const NON_PROFILE_DIRS: ReadonlySet<string> = new Set([
  "System Profile",
  "Guest Profile",
]);

export const formatProfileLabel = (name: string, email: string | undefined, dir: string): string =>
  `${name} (${email && email.length > 0 ? email : dir})`;

const JsonObject = Type.Record(Type.String(), Type.Unknown());

const jsonObjectValidator = Compile(JsonObject);

const readJsonFile = async (path: string): Promise<Record<string, unknown> | null> => {
  let raw: string;
  try {
    raw = await readFile(path, "utf8");
  } catch {
    return null;
  }
  const parsed = parseJson(raw, jsonObjectValidator);
  return parsed.success ? parsed.data : null;
};

const asRecord = (v: unknown): Record<string, unknown> | null =>
  jsonObjectValidator.Check(v) ? v : null;

const asString = (v: unknown): string | undefined =>
  typeof v === "string" && v.length > 0 ? v : undefined;

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
    // Ephemeral (guest-like) profiles vanish when their window closes, so they can never be a durable pin.
    if (entry["is_ephemeral"] === true) continue;
    entries.push({ dir, entry });
  }

  const ordered = orderDirs(entries.map((e) => e.dir), order);
  const byDir = new Map(entries.map((e) => [e.dir, e.entry]));

  return ordered.flatMap((dir) => {
    const entry = byDir.get(dir);
    if (!entry) return [];
    const name = asString(entry["name"]) ?? asString(entry["gaia_name"]);
    const email = asString(entry["user_name"]);
    return [buildProfile(dir, name, email, dir === lastUsed)];
  });
};

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
    if (!prefs) continue;
    const profileNode = asRecord(prefs["profile"]);
    const name = profileNode ? asString(profileNode["name"]) : undefined;
    const accounts = prefs["account_info"];
    const firstAccount = Array.isArray(accounts) ? asRecord(accounts[0]) : null;
    const email = firstAccount ? asString(firstAccount["email"]) : undefined;
    profiles.push(buildProfile(dir, name, email, false));
  }
  return profiles;
};

export const listProfiles = async (userDataDir: string): Promise<ReadonlyArray<BrowserProfile>> => {
  const fromLocalState = await listFromLocalState(userDataDir);
  if (fromLocalState.length > 0) return fromLocalState;
  return listFromPreferencesScan(userDataDir);
};
