/**
 * Unit tests for the profile pin store — no browser required.
 *
 * Redirects pi's agent dir via $PI_CODING_AGENT_DIR so the real
 * ~/.pi/agent/browser-harness.json is never touched.
 *
 * Run: npx tsx test/profile/store-test.ts
 */
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

const pin = {
  userDataDir: "/home/u/.config/google-chrome",
  profileDir: "Profile 1",
  label: "Aman (aman@example.com)",
  savedAt: new Date(0).toISOString(),
};

async function main(): Promise<void> {
  const sandbox = mkdtempSync(join(tmpdir(), "pi-pin-test-"));
  process.env["PI_CODING_AGENT_DIR"] = sandbox;

  // Imported after the env override so paths.ts resolves into the sandbox.
  const { pinFilePath } = await import("../../src/profile/paths");
  const { readPin, writePin, clearPin } = await import("../../src/profile/store");

  // P1: agent dir honours the env override
  check(pinFilePath() === join(sandbox, "browser-harness.json"), "P1: pin path follows $PI_CODING_AGENT_DIR");

  // P2: nothing written yet
  check((await readPin()) === null, "P2: absent file reads as no pin");

  // P3: round trip
  {
    const written = await writePin(pin);
    check(written.success, "P3: write succeeds");
    const read = await readPin();
    check(read?.profileDir === "Profile 1", "P3: profileDir round-trips");
    check(read?.userDataDir === pin.userDataDir, "P3: userDataDir round-trips");
    check(read?.label === pin.label, "P3: label round-trips");
  }

  // P4: no temp files survive an atomic write
  check(readdirSync(sandbox).filter((f) => f.endsWith(".tmp")).length === 0, "P4: write leaves no .tmp files");

  // P5: overwrite replaces rather than appends
  {
    await writePin({ ...pin, profileDir: "Default", label: "Work (work@example.com)" });
    const read = await readPin();
    check(read?.profileDir === "Default", "P5: second write replaces the first");
    check(readdirSync(sandbox).filter((f) => f === "browser-harness.json").length === 1, "P5: one pin file on disk");
  }

  // P6: clear
  {
    const cleared = await clearPin();
    check(cleared.success, "P6: clear succeeds");
    check((await readPin()) === null, "P6: cleared pin reads as none");
  }

  // P7: corrupt file degrades to no pin
  writeFileSync(pinFilePath(), "{ not json at all", "utf8");
  check((await readPin()) === null, "P7: malformed JSON reads as no pin");

  // P8: unknown schema version is not guessed at
  writeFileSync(pinFilePath(), JSON.stringify({ version: 99, profile: pin }), "utf8");
  check((await readPin()) === null, "P8: future version reads as no pin");

  // P9: structurally invalid pin is rejected
  writeFileSync(pinFilePath(), JSON.stringify({ version: 1, profile: { profileDir: 42 } }), "utf8");
  check((await readPin()) === null, "P9: wrong field types read as no pin");

  // P10: a missing agent dir is created on write
  {
    rmSync(sandbox, { recursive: true, force: true });
    const written = await writePin(pin);
    check(written.success, "P10: write recreates a missing agent dir");
    check((await readPin())?.profileDir === "Profile 1", "P10: pin readable after dir recreation");
  }

  // P11: an unwritable location surfaces as an error result, not a throw
  {
    const blocked = join(sandbox, "blocked");
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, "browser-harness.json"), "{}", "utf8");
    // Point the agent dir at a FILE — mkdir/write must fail cleanly.
    process.env["PI_CODING_AGENT_DIR"] = join(blocked, "browser-harness.json");
    const { writePin: writeAgain } = await import(`../../src/profile/store?nocache=${Date.now()}`);
    const written = await writeAgain(pin);
    check(!written.success, "P11: write into an invalid dir returns an error result");
    process.env["PI_CODING_AGENT_DIR"] = sandbox;
  }

  rmSync(sandbox, { recursive: true, force: true });

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("profile store test failed:", e);
  process.exit(1);
});
