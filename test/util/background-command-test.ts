import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { registerBackgroundCommand } from "../../src/background";
import { clearPin, readBackgroundMode, readPin, writeBackgroundMode, writePin } from "../../src/profile/store";
import { pinFilePath } from "../../src/profile/paths";
import { neverActivate, setNeverActivate } from "../../src/util/activation";
import { err } from "../../src/util/result";
import { fakeCtx, fakePi } from "../helpers/fake-pi";

const pin = { userDataDir: "/udd", profileDir: "Profile 1", label: "Work", savedAt: new Date(0).toISOString() };

let sandbox: string;
let savedAgentDir: string | undefined;

before(() => {
  sandbox = mkdtempSync(join(tmpdir(), "pi-background-test-"));
  savedAgentDir = process.env["PI_CODING_AGENT_DIR"];
  process.env["PI_CODING_AGENT_DIR"] = sandbox;
});

after(() => {
  if (savedAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
  else process.env["PI_CODING_AGENT_DIR"] = savedAgentDir;
  rmSync(sandbox, { recursive: true, force: true });
  setNeverActivate(false);
});

beforeEach(() => {
  rmSync(pinFilePath(), { force: true });
  setNeverActivate(false);
});

describe("background mode setting on disk", () => {
  test("it is off when nothing has been saved, and for a file written before the setting existed", async () => {
    assert.equal(await readBackgroundMode(), false);
    writeFileSync(pinFilePath(), JSON.stringify({ version: 1, profile: pin }), "utf8");
    assert.equal(await readBackgroundMode(), false);
    assert.deepEqual(await readPin(), pin);
  });

  test("it round-trips, and off is stored by leaving the key out", async () => {
    assert.equal((await writeBackgroundMode(true)).success, true);
    assert.equal(await readBackgroundMode(), true);
    assert.equal((await writeBackgroundMode(false)).success, true);
    assert.equal(await readBackgroundMode(), false);
    assert.deepEqual(JSON.parse(readFileSync(pinFilePath(), "utf8")), { version: 1, profile: null });
  });

  test("anything but true reads as off", async () => {
    writeFileSync(pinFilePath(), JSON.stringify({ version: 1, profile: null, background: "yes" }), "utf8");
    assert.equal(await readBackgroundMode(), false);
  });

  test("saving it keeps the profile pin, and saving or clearing the pin keeps it", async () => {
    await writePin(pin);
    await writeBackgroundMode(true);
    assert.deepEqual(await readPin(), pin, "turning background mode on dropped the pin");
    await writePin({ ...pin, label: "Other" });
    assert.equal(await readBackgroundMode(), true, "saving a pin turned background mode off");
    await clearPin();
    assert.equal(await readBackgroundMode(), true, "clearing the pin turned background mode off");
    assert.equal(await readPin(), null);
  });
});

describe("/browser-background", () => {
  const command = (deps: Parameters<typeof registerBackgroundCommand>[1] = {}) => {
    const pi = fakePi();
    registerBackgroundCommand(pi.pi, deps);
    return pi.command("browser-background");
  };

  test("it is registered with a description", () => {
    assert.ok(command().description);
  });

  test("'on' saves the setting, applies it at once and says what changes", async () => {
    const ctx = fakeCtx({ hasUI: false });
    await command().handler("on", ctx.ctx);
    assert.equal(neverActivate(), true);
    assert.equal(await readBackgroundMode(), true);
    assert.equal(ctx.notices.length, 1);
    assert.match(ctx.notices[0]?.message ?? "", /^Background mode: on/);
    assert.match(ctx.notices[0]?.message ?? "", /browser_click and browser_drag_and_drop are refused/);
  });

  test("'off' saves and applies the default again", async () => {
    await writeBackgroundMode(true);
    setNeverActivate(true);
    const ctx = fakeCtx({ hasUI: false });
    await command().handler(" OFF ", ctx.ctx);
    assert.equal(neverActivate(), false);
    assert.equal(await readBackgroundMode(), false);
    assert.match(ctx.notices[0]?.message ?? "", /^Background mode: off/);
  });

  test("with no argument and a UI the user picks from a list that marks the current choice", async () => {
    const ctx = fakeCtx({ selections: ["  On: never bring the browser to the front"] });
    await command().handler("", ctx.ctx);
    assert.deepEqual(ctx.prompts.map((p) => p.title), ["Background mode"]);
    assert.deepEqual(ctx.prompts[0]?.options, [
      "  On: never bring the browser to the front",
      "✓ Off: the browser comes forward when the agent uses it (default)",
    ]);
    assert.equal(neverActivate(), true);
    assert.equal(await readBackgroundMode(), true);
  });

  test("escaping the list changes nothing", async () => {
    await writeBackgroundMode(true);
    setNeverActivate(true);
    const ctx = fakeCtx({ selections: [undefined] });
    await command().handler("", ctx.ctx);
    assert.equal(neverActivate(), true);
    assert.equal(await readBackgroundMode(), true);
    assert.match(ctx.notices[0]?.message ?? "", /unchanged \(on\)/);
  });

  test("with no argument and no UI it reports the current setting and how to change it", async () => {
    const ctx = fakeCtx({ hasUI: false });
    await command().handler("", ctx.ctx);
    assert.equal(neverActivate(), false);
    assert.match(ctx.notices[0]?.message ?? "", /Background mode is off\. Run \/browser-background on/);
  });

  test("an unknown argument changes nothing and shows the usage", async () => {
    const ctx = fakeCtx({ hasUI: false });
    await command().handler("maybe", ctx.ctx);
    assert.equal(neverActivate(), false);
    assert.equal(await readBackgroundMode(), false);
    assert.match(ctx.notices[0]?.message ?? "", /^Usage: \/browser-background \[on\|off\]/);
  });

  test("a failed save is reported and the running session is left as it was", async () => {
    const ctx = fakeCtx({ hasUI: false });
    await command({ writeBackgroundMode: () => Promise.resolve(err("disk full")) }).handler("on", ctx.ctx);
    assert.equal(neverActivate(), false);
    assert.deepEqual(ctx.notices.map((n) => n.message), ["disk full"]);
  });
});
