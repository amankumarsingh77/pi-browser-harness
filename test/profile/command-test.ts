import { test, describe, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promptForProfileIfUnset, registerProfileCommand, type ProfileCommandDeps } from "../../src/profile/command";
import { readPin, writePin, type ProfilePin } from "../../src/profile/store";
import type { BrowserClient } from "../../src/client";
import type { DaemonStatus } from "../../src/cdp/types";
import { cdpError } from "../../src/cdp/errors";
import { err, ok } from "../../src/util/result";
import { createFakeClient } from "../domains/fake-client";
import { fakeCtx, fakePi } from "../helpers/fake-pi";

const CLEAR = "— Clear selection (use whichever window is focused) —";

// A user-data-dir on disk with the given profiles; `listProfiles` reads Local State's info_cache.
const writeUserDataDir = (root: string, profiles: Readonly<Record<string, { readonly name: string; readonly user_name?: string }>>): string => {
  const udd = mkdtempSync(join(root, "udd-"));
  writeFileSync(
    join(udd, "Local State"),
    JSON.stringify({ profile: { profiles_order: Object.keys(profiles), info_cache: profiles } }),
    "utf8",
  );
  for (const dir of Object.keys(profiles)) mkdirSync(join(udd, dir));
  return udd;
};

type ClientRecorder = {
  readonly client: BrowserClient;
  readonly pins: ReadonlyArray<ProfilePin | null>;
  readonly lifecycle: ReadonlyArray<string>;
};

// The fake client with a connected user-data-dir and a pin that follows setProfilePin, so the
// command never has to discover a browser on this machine.
const recordingClient = async (opts: {
  readonly userDataDir?: string;
  readonly pin?: ProfilePin | null;
  readonly alive?: boolean;
  readonly startFails?: boolean;
}): Promise<ClientRecorder> => {
  const fake = await createFakeClient();
  const pins: Array<ProfilePin | null> = [];
  const lifecycle: string[] = [];
  let pin: ProfilePin | null = opts.pin ?? null;
  const status: DaemonStatus = { alive: opts.alive ?? false, sessionId: null, namespace: "fake" };
  const client: BrowserClient = {
    ...fake.client,
    userDataDir: () => opts.userDataDir,
    profilePin: () => pin,
    setProfilePin: (next) => {
      pin = next;
      pins.push(next);
    },
    status: () => status,
    closeOwnedTabs: () => {
      lifecycle.push("closeOwnedTabs");
      return Promise.resolve();
    },
    stop: () => {
      lifecycle.push("stop");
      return Promise.resolve();
    },
    start: () => {
      lifecycle.push("start");
      return Promise.resolve(opts.startFails ? err(cdpError("discovery_failed", "no chrome")) : ok(undefined));
    },
  };
  return { client, pins, lifecycle };
};

const pinOf = (udd: string, dir: string, label: string): ProfilePin => ({ userDataDir: udd, profileDir: dir, label, savedAt: "" });

describe("profile command", () => {
  let sandbox: string;
  let udd: string;
  let savedAgentDir: string | undefined;

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), "pi-profile-cmd-"));
    savedAgentDir = process.env["PI_CODING_AGENT_DIR"];
    udd = writeUserDataDir(sandbox, {
      Default: { name: "Alice", user_name: "alice@example.com" },
      "Profile 1": { name: "Bob", user_name: "bob@example.com" },
    });
  });

  // Each test starts without a stored pin: the agent dir is a fresh sub-directory.
  beforeEach(() => {
    process.env["PI_CODING_AGENT_DIR"] = mkdtempSync(join(sandbox, "agent-"));
  });

  after(() => {
    if (savedAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
    else process.env["PI_CODING_AGENT_DIR"] = savedAgentDir;
    rmSync(sandbox, { recursive: true, force: true });
  });

  const run = async (client: BrowserClient, ctxOpts: Parameters<typeof fakeCtx>[0], deps: ProfileCommandDeps = {}) => {
    const pi = fakePi();
    registerProfileCommand(pi.pi, client, deps);
    const cmd = pi.command("browser-profile");
    const ctx = fakeCtx(ctxOpts);
    await cmd.handler("", ctx.ctx);
    return { cmd, ...ctx };
  };

  test("registers browser-profile with a description", async () => {
    const pi = fakePi();
    registerProfileCommand(pi.pi, (await recordingClient({})).client);
    assert.deepEqual(pi.commands.map((c) => c.name), ["browser-profile"]);
    assert.match(pi.command("browser-profile").description ?? "", /profile/i);
  });

  test("lists the connected browser's profiles and pins the chosen one", async () => {
    const rec = await recordingClient({ userDataDir: udd });
    const r = await run(rec.client, { selections: ["  Bob (bob@example.com)"] });
    const prompt = r.prompts[0];
    assert.ok(prompt);
    assert.deepEqual(prompt.options, ["  Alice (alice@example.com)", "  Bob (bob@example.com)", CLEAR]);
    assert.equal(prompt.title, "Select browser profile");
    const stored = await readPin();
    assert.ok(stored);
    assert.equal(stored.profileDir, "Profile 1");
    assert.equal(stored.userDataDir, udd);
    assert.equal(rec.pins[0]?.label, "Bob (bob@example.com)");
    const notice = r.notices[0];
    assert.ok(notice);
    assert.equal(notice.type, "info");
    assert.match(notice.message, /Browser profile: Bob \(bob@example.com\)/);
  });

  test("the current pin is ticked in the list", async () => {
    const rec = await recordingClient({ userDataDir: udd, pin: pinOf(udd, "Profile 1", "Bob (bob@example.com)") });
    const r = await run(rec.client, { selections: [undefined] });
    assert.deepEqual(r.prompts[0]?.options, ["  Alice (alice@example.com)", "✓ Bob (bob@example.com)", CLEAR]);
  });

  test("a stored pin is ticked when the client has none", async () => {
    assert.ok((await writePin(pinOf(udd, "Default", "Alice (alice@example.com)"))).success);
    const rec = await recordingClient({ userDataDir: udd });
    const r = await run(rec.client, { selections: [undefined] });
    assert.equal(r.prompts[0]?.options[0], "✓ Alice (alice@example.com)");
  });

  test("escaping the selector changes nothing", async () => {
    const rec = await recordingClient({ userDataDir: udd });
    const r = await run(rec.client, { selections: [undefined] });
    assert.deepEqual(r.notices, [{ message: "Profile unchanged.", type: "info" }]);
    assert.equal(rec.pins.length, 0);
    assert.equal(await readPin(), null);
  });

  test("choosing the clear row removes the stored pin and clears the client's", async () => {
    assert.ok((await writePin(pinOf(udd, "Default", "Alice"))).success);
    const rec = await recordingClient({ userDataDir: udd, pin: pinOf(udd, "Default", "Alice") });
    const r = await run(rec.client, { selections: [CLEAR] });
    assert.deepEqual(rec.pins, [null]);
    assert.equal(await readPin(), null);
    assert.match(r.notices[0]?.message ?? "", /Profile selection cleared/);
    assert.equal(rec.lifecycle.length, 0, "clearing does not restart the session");
  });

  test("without an interactive terminal the command only explains itself", async () => {
    const rec = await recordingClient({ userDataDir: udd });
    const r = await run(rec.client, { hasUI: false });
    assert.equal(r.prompts.length, 0);
    assert.deepEqual(r.notices, [{ message: "Profile selection needs an interactive terminal.", type: "warning" }]);
  });

  test("a user-data-dir without profiles is reported as an error", async () => {
    const empty = mkdtempSync(join(sandbox, "empty-"));
    const rec = await recordingClient({ userDataDir: empty });
    const r = await run(rec.client, { selections: ["anything"] });
    assert.equal(r.prompts.length, 0);
    const notice = r.notices[0];
    assert.ok(notice);
    assert.equal(notice.type, "error");
    assert.match(notice.message, new RegExp(`No profiles found in ${empty.replaceAll("\\", "\\\\")}`));
  });

  test("a live session is restarted after pinning, in the order close tabs, stop, start", async () => {
    const rec = await recordingClient({ userDataDir: udd, alive: true });
    const r = await run(rec.client, { selections: ["  Alice (alice@example.com)"] });
    assert.deepEqual(rec.lifecycle, ["closeOwnedTabs", "stop", "start"]);
    assert.equal(r.notices[0]?.type, "info");
  });

  test("a dead session is left alone after pinning", async () => {
    const rec = await recordingClient({ userDataDir: udd, alive: false });
    await run(rec.client, { selections: ["  Alice (alice@example.com)"] });
    assert.deepEqual(rec.lifecycle, []);
  });

  test("a restart failure keeps the saved pin but warns", async () => {
    const rec = await recordingClient({ userDataDir: udd, alive: true, startFails: true });
    const r = await run(rec.client, { selections: ["  Alice (alice@example.com)"] });
    assert.equal((await readPin())?.profileDir, "Default");
    const notice = r.notices[0];
    assert.ok(notice);
    assert.equal(notice.type, "warning");
    assert.match(notice.message, /Saved Alice \(alice@example.com\), but switching the open session failed: no chrome/);
  });

  // Without a connected client the user-data-dir comes from the DevTools endpoint's own report,
  // then from a scan of the candidate directories; both are injected so nothing on this machine is probed.
  describe("user-data-dir fallback when the client is not connected", () => {
    const endpointFails: ProfileCommandDeps["discoverEndpoint"] = () =>
      Promise.resolve(err(cdpError("discovery_failed", "no DevTools endpoint")));

    test("the endpoint's user-data-dir wins and the candidate scan is skipped", async () => {
      const rec = await recordingClient({});
      let scanned = false;
      const r = await run(rec.client, { selections: ["  Bob (bob@example.com)"] }, {
        discoverEndpoint: () => Promise.resolve(ok({ wsUrl: "ws://127.0.0.1:9222/devtools/browser/x", userDataDir: udd })),
        userDataDirCandidates: () => { scanned = true; return []; },
      });
      assert.equal(scanned, false);
      assert.deepEqual(r.prompts[0]?.options, ["  Alice (alice@example.com)", "  Bob (bob@example.com)", CLEAR]);
      assert.equal((await readPin())?.userDataDir, udd);
    });

    test("an endpoint without a user-data-dir falls through to the candidate scan", async () => {
      const rec = await recordingClient({});
      const r = await run(rec.client, { selections: [undefined] }, {
        discoverEndpoint: () => Promise.resolve(ok({ wsUrl: "ws://127.0.0.1:9222/devtools/browser/x" })),
        userDataDirCandidates: () => [mkdtempSync(join(sandbox, "empty-")), udd],
      });
      assert.equal(r.prompts.length, 1, "the one candidate with profiles is listed");
      assert.deepEqual(r.notices, [{ message: "Profile unchanged.", type: "info" }]);
    });

    test("a single candidate with profiles is used when discovery fails", async () => {
      const rec = await recordingClient({});
      const r = await run(rec.client, { selections: ["  Alice (alice@example.com)"] }, {
        discoverEndpoint: endpointFails,
        userDataDirCandidates: () => [mkdtempSync(join(sandbox, "empty-")), udd],
      });
      assert.equal((await readPin())?.userDataDir, udd);
      assert.equal(r.notices[0]?.type, "info");
    });

    test("no candidate with profiles is reported as an error", async () => {
      const rec = await recordingClient({});
      const r = await run(rec.client, { selections: ["x"] }, {
        discoverEndpoint: endpointFails,
        userDataDirCandidates: () => [mkdtempSync(join(sandbox, "empty-")), join(sandbox, "does-not-exist")],
      });
      assert.equal(r.prompts.length, 0);
      assert.deepEqual(r.notices, [{
        message: "No browser profiles found on this machine. Open Chrome, Brave, or Edge and try again.",
        type: "error",
      }]);
      assert.equal(rec.pins.length, 0);
    });

    test("profiles in more than one browser is an error naming each browser", async () => {
      const brave = mkdtempSync(join(sandbox, "BraveSoftware-"));
      writeFileSync(
        join(brave, "Local State"),
        JSON.stringify({ profile: { profiles_order: ["Default"], info_cache: { Default: { name: "Brave Me" } } } }),
        "utf8",
      );
      mkdirSync(join(brave, "Default"));
      const chrome = mkdtempSync(join(sandbox, "google-chrome-"));
      writeFileSync(
        join(chrome, "Local State"),
        JSON.stringify({ profile: { profiles_order: ["Default"], info_cache: { Default: { name: "Chrome Me" } } } }),
        "utf8",
      );
      mkdirSync(join(chrome, "Default"));
      const rec = await recordingClient({});
      const r = await run(rec.client, { selections: ["x"] }, {
        discoverEndpoint: endpointFails,
        userDataDirCandidates: () => [chrome, brave],
      });
      assert.equal(r.prompts.length, 0);
      const notice = r.notices[0];
      assert.ok(notice);
      assert.equal(notice.type, "error");
      assert.match(notice.message, /^Found profiles for more than one browser \(Chrome, Brave\)\. Open the browser you want/);
    });

    test("promptForProfileIfUnset resolves the directory through the same seam", async () => {
      const rec = await recordingClient({});
      const ctx = fakeCtx({ selections: ["  Alice (alice@example.com)"] });
      const note = await promptForProfileIfUnset(rec.client, ctx.ctx, {
        discoverEndpoint: endpointFails,
        userDataDirCandidates: () => [udd],
      });
      assert.equal(note, "Browser profile: Alice (alice@example.com)");
      assert.equal((await readPin())?.userDataDir, udd);
    });
  });

  test("profiles sharing a label are disambiguated by directory", async () => {
    const twins = writeUserDataDir(sandbox, {
      Default: { name: "Same", user_name: "same@example.com" },
      "Profile 2": { name: "Same", user_name: "same@example.com" },
      "Profile 3": { name: "Other", user_name: "other@example.com" },
    });
    const rec = await recordingClient({ userDataDir: twins });
    const r = await run(rec.client, { selections: ["  Same (same@example.com) [Profile 2]"] });
    assert.deepEqual(r.prompts[0]?.options, [
      "  Same (same@example.com) [Default]",
      "  Same (same@example.com) [Profile 2]",
      "  Other (other@example.com)",
      CLEAR,
    ]);
    assert.equal((await readPin())?.profileDir, "Profile 2");
  });
});

describe("promptForProfileIfUnset", () => {
  let sandbox: string;
  let udd: string;
  let savedAgentDir: string | undefined;

  before(() => {
    sandbox = mkdtempSync(join(tmpdir(), "pi-profile-unset-"));
    savedAgentDir = process.env["PI_CODING_AGENT_DIR"];
    udd = writeUserDataDir(sandbox, { Default: { name: "Alice", user_name: "alice@example.com" } });
  });

  beforeEach(() => {
    process.env["PI_CODING_AGENT_DIR"] = mkdtempSync(join(sandbox, "agent-"));
  });

  after(() => {
    if (savedAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
    else process.env["PI_CODING_AGENT_DIR"] = savedAgentDir;
    rmSync(sandbox, { recursive: true, force: true });
  });

  const HINT = "No browser profile selected — using whichever window is focused. Run /browser-profile to pin one.";

  test("a client that already has a pin is left alone and nothing is said", async () => {
    const rec = await recordingClient({ userDataDir: udd, pin: pinOf(udd, "Default", "Alice") });
    const ctx = fakeCtx({ selections: ["  Alice (alice@example.com)"] });
    assert.equal(await promptForProfileIfUnset(rec.client, ctx.ctx), undefined);
    assert.equal(ctx.prompts.length, 0);
    assert.equal(rec.pins.length, 0);
  });

  test("a stored pin is adopted silently without prompting", async () => {
    const stored = pinOf(udd, "Default", "Alice (alice@example.com)");
    assert.ok((await writePin(stored)).success);
    const rec = await recordingClient({ userDataDir: udd });
    const ctx = fakeCtx({ selections: ["  Alice (alice@example.com)"] });
    assert.equal(await promptForProfileIfUnset(rec.client, ctx.ctx), undefined);
    assert.equal(ctx.prompts.length, 0);
    assert.equal(rec.pins[0]?.profileDir, "Default");
  });

  test("without a context (or without UI) it returns the hint and pins nothing", async () => {
    const rec = await recordingClient({ userDataDir: udd });
    assert.equal(await promptForProfileIfUnset(rec.client, undefined), HINT);
    assert.equal(await promptForProfileIfUnset(rec.client, fakeCtx({ hasUI: false }).ctx), HINT);
    assert.equal(rec.pins.length, 0);
    assert.equal(await readPin(), null);
  });

  test("with UI it prompts with the setup title, saves the choice and reports it", async () => {
    const rec = await recordingClient({ userDataDir: udd });
    const ctx = fakeCtx({ selections: ["  Alice (alice@example.com)"] });
    assert.equal(await promptForProfileIfUnset(rec.client, ctx.ctx), "Browser profile: Alice (alice@example.com)");
    assert.equal(ctx.prompts[0]?.title, "Select the browser profile the agent should use");
    assert.equal((await readPin())?.profileDir, "Default");
    assert.equal(rec.pins[0]?.label, "Alice (alice@example.com)");
  });

  test("escaping or picking the clear row yields the hint and pins nothing", async () => {
    const rec = await recordingClient({ userDataDir: udd });
    assert.equal(await promptForProfileIfUnset(rec.client, fakeCtx({ selections: [undefined] }).ctx), HINT);
    assert.equal(await promptForProfileIfUnset(rec.client, fakeCtx({ selections: [CLEAR] }).ctx), HINT);
    assert.equal(rec.pins.length, 0);
    assert.equal(await readPin(), null);
  });

  test("a user-data-dir without profiles turns into the load error", async () => {
    const empty = mkdtempSync(join(sandbox, "empty-"));
    const rec = await recordingClient({ userDataDir: empty });
    const ctx = fakeCtx({ selections: ["x"] });
    assert.match((await promptForProfileIfUnset(rec.client, ctx.ctx)) ?? "", /No profiles found in/);
    assert.equal(ctx.prompts.length, 0);
  });
});
