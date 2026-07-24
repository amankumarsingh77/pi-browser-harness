/**
 * Unit tests for profile enumeration — no browser required.
 *
 * Builds throwaway user-data-dirs on disk so both tiers (Local State and the
 * Preferences scan) run against real files.
 *
 * Run: npx tsx test/profile/list-test.ts
 */
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatProfileLabel, listProfiles } from "../../src/profile/list";

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string): void => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
};

const roots: string[] = [];
const makeUdd = (): string => {
  const dir = mkdtempSync(join(tmpdir(), "pi-profile-test-"));
  roots.push(dir);
  return dir;
};
const writeLocalState = (udd: string, body: unknown): void =>
  writeFileSync(join(udd, "Local State"), typeof body === "string" ? body : JSON.stringify(body), "utf8");
const writeProfileDir = (udd: string, dir: string, prefs?: unknown): void => {
  mkdirSync(join(udd, dir), { recursive: true });
  if (prefs !== undefined) writeFileSync(join(udd, dir, "Preferences"), JSON.stringify(prefs), "utf8");
};

async function main(): Promise<void> {
  // L1: tier 1 — names, emails, ordering, last-used marker
  {
    const udd = makeUdd();
    writeLocalState(udd, {
      profile: {
        last_used: "Profile 1",
        profiles_order: ["Default", "Profile 1", "Profile 2"],
        info_cache: {
          "Profile 2": { name: "Second", user_name: "second@example.com" },
          Default: { name: "vertexcover.io", user_name: "aman@vertexcover.io" },
          "Profile 1": { name: "Aman", user_name: "aman@personal.com" },
        },
      },
    });
    const profiles = await listProfiles(udd);
    check(profiles.length === 3, "L1: all three profiles listed");
    check(
      profiles.map((p) => p.dir).join(",") === "Default,Profile 1,Profile 2",
      "L1: profiles_order drives ordering, not object key order",
    );
    check(profiles[1]?.label === "Aman (aman@personal.com)", "L1: label is 'Name (email)'");
    check(profiles[1]?.lastUsed === true, "L1: last_used profile is marked");
    check(profiles[0]?.lastUsed === false, "L1: other profiles are not marked");
  }

  // L2: profile with no signed-in account falls back to the directory
  {
    const udd = makeUdd();
    writeLocalState(udd, { profile: { info_cache: { "Profile 3": { name: "Work" } } } });
    const profiles = await listProfiles(udd);
    check(profiles[0]?.label === "Work (Profile 3)", "L2: no account → 'Name (dir)'");
    check(profiles[0]?.email === undefined, "L2: email stays undefined");
  }

  // L3: gaia_name backfills a missing name; ephemeral profiles are skipped
  {
    const udd = makeUdd();
    writeLocalState(udd, {
      profile: {
        info_cache: {
          "Profile 4": { gaia_name: "Aman Kumar", user_name: "gaia@example.com" },
          "Profile 5": { name: "Ghost", user_name: "ghost@example.com", is_ephemeral: true },
          "System Profile": { name: "System" },
        },
      },
    });
    const profiles = await listProfiles(udd);
    check(profiles.length === 1, "L3: ephemeral and System Profile entries are excluded");
    check(profiles[0]?.label === "Aman Kumar (gaia@example.com)", "L3: gaia_name backfills a missing name");
  }

  // L4: unlisted profiles are appended alphabetically after profiles_order
  {
    const udd = makeUdd();
    writeLocalState(udd, {
      profile: {
        profiles_order: ["Profile 9"],
        info_cache: {
          Default: { name: "D" },
          "Profile 9": { name: "Nine" },
          "Profile 3": { name: "Three" },
        },
      },
    });
    const profiles = await listProfiles(udd);
    check(
      profiles.map((p) => p.dir).join(",") === "Profile 9,Default,Profile 3",
      "L4: ordered entries first, remainder alphabetical",
    );
  }

  // L5: corrupt Local State falls through to the Preferences scan
  {
    const udd = makeUdd();
    writeLocalState(udd, "{ this is not json");
    writeProfileDir(udd, "Default", {
      profile: { name: "Fallback Name" },
      account_info: [{ email: "fallback@example.com" }],
    });
    writeProfileDir(udd, "Crash Reports"); // no Preferences → not a profile
    const profiles = await listProfiles(udd);
    check(profiles.length === 1, "L5: only directories holding Preferences count as profiles");
    check(profiles[0]?.label === "Fallback Name (fallback@example.com)", "L5: tier 2 reads name + account email");
  }

  // L6: missing info_cache also falls through to tier 2
  {
    const udd = makeUdd();
    writeLocalState(udd, { profile: { last_used: "Default" } });
    writeProfileDir(udd, "Profile 1", { profile: { name: "Tier Two" } });
    const profiles = await listProfiles(udd);
    check(profiles[0]?.label === "Tier Two (Profile 1)", "L6: missing info_cache → Preferences scan");
  }

  // L7: nothing readable → empty list, never a throw
  {
    const profiles = await listProfiles(join(tmpdir(), "pi-profile-does-not-exist-xyz"));
    check(profiles.length === 0, "L7: unreadable user-data-dir yields an empty list");
  }

  // L8: label formatting is total
  {
    check(formatProfileLabel("A", "a@b.c", "Default") === "A (a@b.c)", "L8: email wins the brackets");
    check(formatProfileLabel("A", undefined, "Profile 7") === "A (Profile 7)", "L8: dir fills in without an email");
    check(formatProfileLabel("A", "", "Profile 7") === "A (Profile 7)", "L8: empty email is treated as absent");
  }

  for (const root of roots) rmSync(root, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("profile list test failed:", e);
  process.exit(1);
});
