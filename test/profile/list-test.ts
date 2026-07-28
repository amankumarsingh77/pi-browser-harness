import { test, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { formatProfileLabel, listProfiles } from "../../src/profile/list";

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

describe("profile enumeration", () => {
  after(() => {
    for (const root of roots) rmSync(root, { recursive: true, force: true });
  });

  const makeL1Udd = (): string => {
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
    return udd;
  };

  test("L1: all three profiles listed", async () => {
    const profiles = await listProfiles(makeL1Udd());
    assert.equal(profiles.length, 3);
  });

  test("L1: profiles_order drives ordering, not object key order", async () => {
    const profiles = await listProfiles(makeL1Udd());
    assert.equal(profiles.map((p) => p.dir).join(","), "Default,Profile 1,Profile 2");
  });

  test("L1: label is 'Name (email)'", async () => {
    const profiles = await listProfiles(makeL1Udd());
    assert.equal(profiles[1]?.label, "Aman (aman@personal.com)");
  });

  test("L1: last_used profile is marked", async () => {
    const profiles = await listProfiles(makeL1Udd());
    assert.equal(profiles[1]?.lastUsed, true);
  });

  test("L1: other profiles are not marked", async () => {
    const profiles = await listProfiles(makeL1Udd());
    assert.equal(profiles[0]?.lastUsed, false);
  });

  const makeL2Udd = (): string => {
    const udd = makeUdd();
    writeLocalState(udd, { profile: { info_cache: { "Profile 3": { name: "Work" } } } });
    return udd;
  };

  test("L2: no account → 'Name (dir)'", async () => {
    const profiles = await listProfiles(makeL2Udd());
    assert.equal(profiles[0]?.label, "Work (Profile 3)");
  });

  test("L2: email stays undefined", async () => {
    const profiles = await listProfiles(makeL2Udd());
    assert.equal(profiles[0]?.email, undefined);
  });

  const makeL3Udd = (): string => {
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
    return udd;
  };

  test("L3: ephemeral and System Profile entries are excluded", async () => {
    const profiles = await listProfiles(makeL3Udd());
    assert.equal(profiles.length, 1);
  });

  test("L3: gaia_name backfills a missing name", async () => {
    const profiles = await listProfiles(makeL3Udd());
    assert.equal(profiles[0]?.label, "Aman Kumar (gaia@example.com)");
  });

  test("L4: ordered entries first, remainder alphabetical", async () => {
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
    assert.equal(profiles.map((p) => p.dir).join(","), "Profile 9,Default,Profile 3");
  });

  const makeL5Udd = (): string => {
    const udd = makeUdd();
    writeLocalState(udd, "{ this is not json");
    writeProfileDir(udd, "Default", {
      profile: { name: "Fallback Name" },
      account_info: [{ email: "fallback@example.com" }],
    });
    writeProfileDir(udd, "Crash Reports");
    return udd;
  };

  test("L5: only directories holding Preferences count as profiles", async () => {
    const profiles = await listProfiles(makeL5Udd());
    assert.equal(profiles.length, 1);
  });

  test("L5: tier 2 reads name + account email", async () => {
    const profiles = await listProfiles(makeL5Udd());
    assert.equal(profiles[0]?.label, "Fallback Name (fallback@example.com)");
  });

  test("L6: missing info_cache → Preferences scan", async () => {
    const udd = makeUdd();
    writeLocalState(udd, { profile: { last_used: "Default" } });
    writeProfileDir(udd, "Profile 1", { profile: { name: "Tier Two" } });
    const profiles = await listProfiles(udd);
    assert.equal(profiles[0]?.label, "Tier Two (Profile 1)");
  });

  test("L7: unreadable user-data-dir yields an empty list", async () => {
    const profiles = await listProfiles(join(tmpdir(), "pi-profile-does-not-exist-xyz"));
    assert.equal(profiles.length, 0);
  });

  test("L8: email wins the brackets", () => {
    assert.equal(formatProfileLabel("A", "a@b.c", "Default"), "A (a@b.c)");
  });

  test("L8: dir fills in without an email", () => {
    assert.equal(formatProfileLabel("A", undefined, "Profile 7"), "A (Profile 7)");
  });

  test("L8: empty email is treated as absent", () => {
    assert.equal(formatProfileLabel("A", "", "Profile 7"), "A (Profile 7)");
  });
});
