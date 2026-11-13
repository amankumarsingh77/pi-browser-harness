import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { performSetup, registerSetupCommand, type SetupDeps } from "../../src/setup";
import { DAEMON_SOCKET_PATH } from "../../src/daemon/protocol";
import type { BrowserClient } from "../../src/client";
import type { ProfilePin } from "../../src/profile/store";
import { cdpError } from "../../src/cdp/errors";
import { err, ok } from "../../src/util/result";
import type { BrowserLocation } from "../../src/browser-location";
import type { InstalledBrowser } from "../../src/profile/installed";
import type { BrowserLaunchRequest } from "../../src/profile/launch";
import { createFakeClient, type FakeClient } from "../domains/fake-client";
import { fakeCtx, fakePi } from "../helpers/fake-pi";
import { underNeverActivate } from "../helpers/never-activate";

const PIN: ProfilePin = { userDataDir: "/home/u/.config/google-chrome", profileDir: "Default", label: "Alice", savedAt: "" };

const REMOTE_ENDPOINT = { wsUrl: "ws://127.0.0.1:9222/devtools/browser/remote" };

const ready: SetupDeps = {
  locateBrowser: () => Promise.resolve({ kind: "local" }),
  ensureDaemon: () => Promise.resolve(true),
  // Nothing installed, so a test that reports "no browser" can never launch a real one.
  installedBrowsers: () => Promise.resolve([]),
  readPin: () => Promise.resolve(null),
};

type SetupClient = {
  readonly client: BrowserClient;
  readonly fake: FakeClient;
  readonly started: () => number;
};

// The fake client with a pin already applied (so setup never reads the on-disk pin) and
// configurable start / newTab / pageInfo outcomes.
const setupClient = async (opts: {
  readonly startError?: string;
  readonly newTabError?: string;
  readonly dialog?: boolean;
  readonly pin?: ProfilePin | null;
} = {}): Promise<SetupClient> => {
  const fake = await createFakeClient();
  let started = 0;
  const client: BrowserClient = {
    ...fake.client,
    profilePin: () => opts.pin === undefined ? PIN : opts.pin,
    start: () => {
      started++;
      return Promise.resolve(opts.startError === undefined ? ok(undefined) : err(cdpError("discovery_failed", opts.startError)));
    },
    newTab: () => Promise.resolve(
      opts.newTabError === undefined ? ok("t-new") : err(cdpError("timeout", opts.newTabError)),
    ),
    pageInfo: () => Promise.resolve(ok(
      opts.dialog
        ? { kind: "dialog", dialog: { type: "alert", message: "hi" } }
        : { kind: "page", url: "https://github.com/", title: "GitHub", width: 1280, height: 720, scrollX: 0, scrollY: 0, pageWidth: 1280, pageHeight: 2000 },
    )),
  };
  return { client, fake, started: () => started };
};

describe("registerSetupCommand", () => {
  test("registers browser-setup once, with a description, and nothing else", async () => {
    const pi = fakePi();
    const fake = await createFakeClient();
    registerSetupCommand(pi.pi, fake.client);
    assert.deepEqual(pi.commands.map((c) => c.name), ["browser-setup"]);
    assert.equal(pi.command("browser-setup").description, "Connect pi to your Chrome browser");
    assert.equal(pi.flags.length, 0);
    assert.equal(pi.tools.length, 0);
    assert.equal(pi.events.length, 0);
  });

  test("the handler notifies the success text as info", async () => {
    const pi = fakePi();
    const c = await setupClient();
    registerSetupCommand(pi.pi, c.client, ready);
    const ctx = fakeCtx();
    await pi.command("browser-setup").handler("", ctx.ctx);
    assert.deepEqual(ctx.notices, [{ message: "Browser connected ✓\nNavigated to: https://github.com/", type: "info" }]);
  });

  test("the handler notifies a failure as an error", async () => {
    const pi = fakePi();
    const c = await setupClient();
    registerSetupCommand(pi.pi, c.client, { ...ready, locateBrowser: () => Promise.resolve({ kind: "none" }) });
    const ctx = fakeCtx();
    await pi.command("browser-setup").handler("", ctx.ctx);
    const notice = ctx.notices[0];
    assert.ok(notice);
    assert.equal(notice.type, "error");
    assert.match(notice.message, /^No browser found\./);
    assert.equal(c.started(), 0);
  });
});

describe("performSetup", () => {
  let agentDir: string;
  let savedAgentDir: string | undefined;

  // A client without a pin makes setup read the on-disk one; keep it off the developer's real pin.
  before(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-setup-test-"));
    savedAgentDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
  });

  after(() => {
    if (savedAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
    else process.env["PI_CODING_AGENT_DIR"] = savedAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("with a running browser and a daemon it starts the client, opens the test tab and reports the page", async () => {
    const c = await setupClient();
    const r = await performSetup(c.client, undefined, ready);
    assert.ok(r.success);
    assert.equal(r.data, "Browser connected ✓\nNavigated to: https://github.com/");
    assert.equal(c.started(), 1);
    assert.equal(c.fake.callsTo("Page.handleJavaScriptDialog").length, 0);
  });

  test("a missing pin with no UI adds the profile hint to the success text", async () => {
    const c = await setupClient({ pin: null });
    const r = await performSetup(c.client, fakeCtx({ hasUI: false }).ctx, ready);
    assert.ok(r.success);
    assert.match(r.data, /^Browser connected ✓\nNavigated to: https:\/\/github\.com\/\nNo browser profile selected/);
  });

  test("no browser anywhere stops before the daemon or the client are touched, and says how to reach a remote one", async () => {
    const c = await setupClient();
    let daemonAsked = false;
    const r = await performSetup(c.client, undefined, {
      ...ready,
      locateBrowser: () => Promise.resolve({ kind: "none" }),
      ensureDaemon: () => { daemonAsked = true; return Promise.resolve(true); },
    });
    assert.equal(r.success, false);
    assert.match(r.error, /^No browser found\. Open your browser and run \/browser-setup\./);
    assert.match(r.error, /127\.0\.0\.1:9222/);
    assert.match(r.error, /BU_CDP_WS/);
    assert.equal(daemonAsked, false);
    assert.equal(c.started(), 0);
  });

  test("a local browser with remote debugging off still reaches the client, which reports the hint", async () => {
    const c = await setupClient({ startError: "DevToolsActivePort not found" });
    const r = await performSetup(c.client, undefined, ready);
    assert.equal(r.success, false);
    assert.match(r.error, /^Browser remote debugging needs to be enabled\./);
    assert.equal(c.started(), 1);
  });

  test("a remote browser connects without a local browser process (#54, #41)", async () => {
    const c = await setupClient();
    const r = await performSetup(c.client, undefined, {
      ...ready,
      locateBrowser: () => Promise.resolve({ kind: "remote", endpoint: REMOTE_ENDPOINT }),
    });
    assert.ok(r.success);
    assert.equal(c.started(), 1);
    assert.match(r.data, /^Browser connected ✓\nNavigated to: https:\/\/github\.com\/\nRemote browser: profile selection is unavailable/);
  });

  test("a remote browser skips the profile prompt: no profile is offered or pinned from this machine", async () => {
    const c = await setupClient({ pin: null });
    const ctx = fakeCtx({ hasUI: true, selections: ["x"] });
    const r = await performSetup(c.client, ctx.ctx, {
      ...ready,
      locateBrowser: () => Promise.resolve({ kind: "remote", endpoint: REMOTE_ENDPOINT }),
    });
    assert.ok(r.success);
    assert.equal(ctx.prompts.length, 0);
    assert.doesNotMatch(r.data, /No browser profile selected|No browser profiles found/);
  });

  test("a daemon that will not start names the socket path", async () => {
    const c = await setupClient();
    const r = await performSetup(c.client, undefined, { ...ready, ensureDaemon: () => Promise.resolve(false) });
    assert.equal(r.success, false);
    assert.equal(r.error, `Could not start the browser daemon. Check ${DAEMON_SOCKET_PATH}.`);
    assert.equal(c.started(), 0);
  });

  for (const marker of ["DevToolsActivePort missing", "remote debugging is off", "connect ECONNREFUSED 127.0.0.1:9222", "Cannot reach Chrome DevTools"]) {
    test(`a start failure mentioning "${marker}" is classified as the remote-debugging hint`, async () => {
      const c = await setupClient({ startError: marker });
      const r = await performSetup(c.client, undefined, ready);
      assert.equal(r.success, false);
      assert.match(r.error, /^Browser remote debugging needs to be enabled\./);
      assert.match(r.error, /chrome:\/\/inspect\/#remote-debugging/);
      assert.match(r.error, /--remote-debugging-port=9222/);
      assert.match(r.error, /BU_CDP_WS/);
    });
  }

  test("any other start failure is reported verbatim as a connection failure", async () => {
    const c = await setupClient({ startError: "daemon socket vanished" });
    const r = await performSetup(c.client, undefined, ready);
    assert.equal(r.success, false);
    assert.equal(r.error, "Connection failed: daemon socket vanished");
  });

  test("a failed test navigation is reported after the client connected", async () => {
    const c = await setupClient({ newTabError: "Target.createTarget timed out" });
    const r = await performSetup(c.client, undefined, ready);
    assert.equal(r.success, false);
    assert.equal(r.error, "Browser connected but test navigation failed: Target.createTarget timed out");
    assert.equal(c.started(), 1);
  });

  test("an open dialog on the test tab is accepted and the URL falls back to github.com", async () => {
    const c = await setupClient({ dialog: true });
    const r = await performSetup(c.client, undefined, ready);
    assert.ok(r.success);
    assert.equal(r.data, "Browser connected ✓\nNavigated to: github.com");
    const accepted = c.fake.callsTo("Page.handleJavaScriptDialog");
    assert.equal(accepted.length, 1);
    assert.deepEqual(accepted[0]?.params, { accept: true });
  });
});

describe("performSetup with a closed local browser", () => {
  const CHROME: InstalledBrowser = { family: "Chrome", exePath: "/usr/bin/google-chrome" };
  const BRAVE: InstalledBrowser = { family: "Brave", exePath: "/usr/bin/brave-browser" };
  const BRAVE_PIN: ProfilePin = { userDataDir: "/home/u/.config/BraveSoftware/Brave-Browser", profileDir: "Profile 2", label: "Work", savedAt: "" };
  const UP: BrowserLocation = { kind: "local", endpoint: { wsUrl: "ws://127.0.0.1:9222/devtools/browser/x", userDataDir: PIN.userDataDir } };

  // The locator answers "none" first (which is what triggers a launch), then walks `after`, repeating its last entry.
  const closed = (opts: {
    readonly installed: ReadonlyArray<InstalledBrowser>;
    readonly after?: ReadonlyArray<BrowserLocation>;
    readonly launchError?: string;
    readonly display?: boolean;
    readonly lookupMs?: number;
  }) => {
    const launches: BrowserLaunchRequest[] = [];
    const after = opts.after ?? [UP];
    let asked = 0;
    // A clock that only sleeping (and, when asked, a slow lookup) moves, so waits are exact and instant.
    let clock = 0;
    const deps: SetupDeps = {
      now: () => clock,
      ensureDaemon: () => Promise.resolve(true),
      readPin: () => Promise.resolve(null),
      installedBrowsers: () => Promise.resolve(opts.installed),
      canShowWindow: () => opts.display ?? true,
      sleep: (ms) => { clock += ms; return Promise.resolve(); },
      launchBrowser: (req) => {
        launches.push(req);
        return Promise.resolve(opts.launchError === undefined ? ok(undefined) : err(opts.launchError));
      },
      locateBrowser: () => {
        const answer: BrowserLocation = asked === 0 ? { kind: "none" } : after[Math.min(asked - 1, after.length - 1)] ?? { kind: "none" };
        asked++;
        clock += opts.lookupMs ?? 0;
        return Promise.resolve(answer);
      },
    };
    return { deps, launches, lookups: () => asked - 1, elapsed: () => clock };
  };

  let agentDir: string;
  let savedAgentDir: string | undefined;

  // A client without a pin makes setup read the on-disk one; keep it off the developer's real pin.
  before(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-setup-launch-test-"));
    savedAgentDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
  });

  after(() => {
    if (savedAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
    else process.env["PI_CODING_AGENT_DIR"] = savedAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("with a UI the user is asked, and on yes the browser is opened and setup carries on", async () => {
    const c = await setupClient();
    const ctx = fakeCtx({ confirms: [true] });
    const { deps, launches } = closed({ installed: [CHROME], after: [{ kind: "none" }, { kind: "local" }, UP] });
    const r = await performSetup(c.client, ctx.ctx, deps);
    assert.ok(r.success);
    assert.deepEqual(ctx.confirmations.map((q) => q.title), ["Open Chrome?"]);
    assert.match(ctx.confirmations[0]?.message ?? "", /in the profile "Alice"/);
    assert.deepEqual(launches, [{ exePath: CHROME.exePath, profileDir: "Default" }]);
    assert.equal(c.started(), 1);
    assert.match(r.data, /^Opened Chrome\.\nBrowser connected ✓/);
  });

  test("a browser setup opened itself is on this machine, whatever the process scan says: profiles stay available", async () => {
    const c = await setupClient();
    const { deps } = closed({ installed: [CHROME], after: [{ kind: "remote", endpoint: REMOTE_ENDPOINT }] });
    const r = await performSetup(c.client, fakeCtx({ hasUI: false }).ctx, deps);
    assert.ok(r.success);
    assert.doesNotMatch(r.data, /Remote browser/);
  });

  test("declining leaves the browser closed and reports that none was found", async () => {
    const c = await setupClient();
    const ctx = fakeCtx({ confirms: [false] });
    const { deps, launches } = closed({ installed: [CHROME] });
    const r = await performSetup(c.client, ctx.ctx, deps);
    assert.equal(r.success, false);
    assert.match(r.error, /^No browser found\./);
    assert.deepEqual(launches, []);
    assert.equal(c.started(), 0);
  });

  test("without a UI a pinned profile is enough: its browser is opened in that profile, unasked", async () => {
    const c = await setupClient({ pin: BRAVE_PIN });
    const ctx = fakeCtx({ hasUI: false });
    const { deps, launches } = closed({ installed: [CHROME, BRAVE] });
    const r = await performSetup(c.client, ctx.ctx, deps);
    assert.ok(r.success);
    assert.deepEqual(ctx.confirmations, []);
    assert.deepEqual(launches, [{ exePath: BRAVE.exePath, profileDir: "Profile 2" }]);
    assert.match(r.data, /^Opened Brave\./);
  });

  test("in background mode a browser is never opened unasked, even with a pin", async () => {
    const c = await setupClient({ pin: BRAVE_PIN });
    const { deps, launches } = closed({ installed: [CHROME, BRAVE] });
    const r = await underNeverActivate(() => performSetup(c.client, fakeCtx({ hasUI: false }).ctx, deps));
    assert.equal(r.success, false);
    assert.match(r.error, /Background mode is on, so Brave was not opened for you/);
    assert.deepEqual(launches, []);
  });

  test("in background mode a user who says yes still gets the browser opened", async () => {
    const c = await setupClient({ pin: BRAVE_PIN });
    const ctx = fakeCtx({ confirms: [true] });
    const { deps, launches } = closed({ installed: [CHROME, BRAVE] });
    const r = await underNeverActivate(() => performSetup(c.client, ctx.ctx, deps));
    assert.ok(r.success);
    assert.equal(launches.length, 1);
  });

  test("a pin saved on disk counts when the client has none loaded yet", async () => {
    const c = await setupClient({ pin: null });
    const { deps, launches } = closed({ installed: [CHROME, BRAVE] });
    const r = await performSetup(c.client, undefined, { ...deps, readPin: () => Promise.resolve(BRAVE_PIN) });
    assert.ok(r.success);
    assert.deepEqual(launches, [{ exePath: BRAVE.exePath, profileDir: "Profile 2" }]);
  });

  test("without a UI and without a pin nothing is opened", async () => {
    const c = await setupClient({ pin: null });
    const { deps, launches } = closed({ installed: [CHROME] });
    const r = await performSetup(c.client, fakeCtx({ hasUI: false }).ctx, deps);
    assert.equal(r.success, false);
    assert.match(r.error, /^No browser found\./);
    assert.deepEqual(launches, []);
  });

  test("several browsers and no pin: none is opened or offered, and the error says why", async () => {
    const c = await setupClient({ pin: null });
    const ctx = fakeCtx({ confirms: [true] });
    const { deps, launches } = closed({ installed: [CHROME, BRAVE] });
    const r = await performSetup(c.client, ctx.ctx, deps);
    assert.equal(r.success, false);
    assert.match(r.error, /^No browser found\./);
    assert.match(r.error, /More than one browser is installed \(Chrome, Brave\)/);
    assert.deepEqual(ctx.confirmations, []);
    assert.deepEqual(launches, []);
  });

  test("a machine with no display never opens a browser", async () => {
    const c = await setupClient();
    const ctx = fakeCtx({ confirms: [true] });
    const { deps, launches } = closed({ installed: [CHROME], display: false });
    const r = await performSetup(c.client, ctx.ctx, deps);
    assert.equal(r.success, false);
    assert.match(r.error, /^No browser found\./);
    assert.deepEqual(ctx.confirmations, []);
    assert.deepEqual(launches, []);
  });

  test("a launch that fails is reported with its cause", async () => {
    const c = await setupClient();
    const { deps } = closed({ installed: [CHROME], launchError: "could not launch /usr/bin/google-chrome: spawn ENOENT" });
    const r = await performSetup(c.client, fakeCtx({ hasUI: false }).ctx, deps);
    assert.equal(r.success, false);
    assert.equal(r.error, "Could not open Chrome: could not launch /usr/bin/google-chrome: spawn ENOENT");
    assert.equal(c.started(), 0);
  });

  test("a browser that was opened but never appears is reported, not waited on forever", async () => {
    const c = await setupClient();
    const { deps, launches } = closed({ installed: [CHROME], after: [{ kind: "none" }] });
    const r = await performSetup(c.client, fakeCtx({ hasUI: false }).ctx, { ...deps, launchWaitMs: 500, launchPollMs: 100 });
    assert.equal(r.success, false);
    assert.match(r.error, /^Opened Chrome, but it did not start\./);
    assert.equal(launches.length, 1);
    assert.equal(c.started(), 0);
  });

  test("an opened browser with remote debugging off stops waiting after the grace period and gets the enable-debugging hint", async () => {
    const c = await setupClient({ startError: "DevToolsActivePort not found" });
    const { deps, elapsed } = closed({ installed: [CHROME], after: [{ kind: "local" }] });
    const r = await performSetup(c.client, fakeCtx({ hasUI: false }).ctx, { ...deps, launchWaitMs: 60_000, launchPollMs: 500 });
    assert.equal(r.success, false);
    assert.match(r.error, /^Browser remote debugging needs to be enabled\./);
    assert.equal(c.started(), 1);
    assert.ok(elapsed() >= 5_000 && elapsed() <= 6_000, `waited ${elapsed()}ms`);
  });

  test("the wait is bounded by elapsed time, so slow lookups cannot stretch it", async () => {
    const c = await setupClient();
    const { deps, lookups, elapsed } = closed({ installed: [CHROME], after: [{ kind: "none" }], lookupMs: 5_000 });
    const r = await performSetup(c.client, fakeCtx({ hasUI: false }).ctx, { ...deps, launchWaitMs: 15_000, launchPollMs: 500 });
    assert.equal(r.success, false);
    assert.match(r.error, /^Opened Chrome, but it did not start\./);
    // The lookup that found no browser in the first place also took 5s, before the wait began.
    const waited = elapsed() - 5_000;
    assert.ok(lookups() <= 3, `${lookups()} lookups`);
    assert.ok(waited <= 17_000, `waited ${waited}ms`);
  });
});
