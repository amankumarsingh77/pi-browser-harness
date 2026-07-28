import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const pin = {
  userDataDir: "/home/u/.config/google-chrome",
  profileDir: "Profile 1",
  label: "Aman (aman@example.com)",
  savedAt: new Date(0).toISOString(),
};

describe("profile pin store", () => {
  let sandbox: string;

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), "pi-pin-test-"));
    process.env["PI_CODING_AGENT_DIR"] = sandbox;
  });

  after(() => {
    rmSync(sandbox, { recursive: true, force: true });
  });

  test("P1: pin path follows $PI_CODING_AGENT_DIR", async () => {
    const { pinFilePath } = await import("../../src/profile/paths");
    assert.equal(pinFilePath(), join(sandbox, "browser-harness.json"));
  });

  test("P2: absent file reads as no pin", async () => {
    const { readPin } = await import("../../src/profile/store");
    assert.equal(await readPin(), null);
  });

  test("P3: write succeeds and round-trips", async () => {
    const { readPin, writePin } = await import("../../src/profile/store");
    const written = await writePin(pin);
    assert.equal(written.success, true);
    const read = await readPin();
    assert.equal(read?.profileDir, "Profile 1");
    assert.equal(read?.userDataDir, pin.userDataDir);
    assert.equal(read?.label, pin.label);
  });

  test("P4: write leaves no .tmp files", () => {
    assert.equal(readdirSync(sandbox).filter((f) => f.endsWith(".tmp")).length, 0);
  });

  test("P5: second write replaces the first", async () => {
    const { readPin, writePin } = await import("../../src/profile/store");
    await writePin({ ...pin, profileDir: "Default", label: "Work (work@example.com)" });
    const read = await readPin();
    assert.equal(read?.profileDir, "Default");
  });

  test("P5: one pin file on disk", () => {
    assert.equal(readdirSync(sandbox).filter((f) => f === "browser-harness.json").length, 1);
  });

  test("P6: clear succeeds", async () => {
    const { clearPin } = await import("../../src/profile/store");
    const cleared = await clearPin();
    assert.equal(cleared.success, true);
  });

  test("P6: cleared pin reads as none", async () => {
    const { readPin } = await import("../../src/profile/store");
    assert.equal(await readPin(), null);
  });

  test("P7: malformed JSON reads as no pin", async () => {
    const { readPin } = await import("../../src/profile/store");
    const { pinFilePath } = await import("../../src/profile/paths");
    writeFileSync(pinFilePath(), "{ not json at all", "utf8");
    assert.equal(await readPin(), null);
  });

  test("P8: future version reads as no pin", async () => {
    const { readPin } = await import("../../src/profile/store");
    const { pinFilePath } = await import("../../src/profile/paths");
    writeFileSync(pinFilePath(), JSON.stringify({ version: 99, profile: pin }), "utf8");
    assert.equal(await readPin(), null);
  });

  test("P9: wrong field types read as no pin", async () => {
    const { readPin } = await import("../../src/profile/store");
    const { pinFilePath } = await import("../../src/profile/paths");
    writeFileSync(pinFilePath(), JSON.stringify({ version: 1, profile: { profileDir: 42 } }), "utf8");
    assert.equal(await readPin(), null);
  });

  test("P10: write recreates a missing agent dir", async () => {
    const { writePin } = await import("../../src/profile/store");
    rmSync(sandbox, { recursive: true, force: true });
    const written = await writePin(pin);
    assert.equal(written.success, true);
  });

  test("P10: pin readable after dir recreation", async () => {
    const { readPin } = await import("../../src/profile/store");
    assert.equal((await readPin())?.profileDir, "Profile 1");
  });

  test("P11: write into an invalid dir returns an error result", async () => {
    const blocked = join(sandbox, "blocked");
    mkdirSync(blocked, { recursive: true });
    writeFileSync(join(blocked, "browser-harness.json"), "{}", "utf8");
    process.env["PI_CODING_AGENT_DIR"] = join(blocked, "browser-harness.json");
    const { writePin: writeAgain } = await import(`../../src/profile/store?nocache=${Date.now()}`);
    const written = await writeAgain(pin);
    assert.equal(written.success, false);
    process.env["PI_CODING_AGENT_DIR"] = sandbox;
  });
});
