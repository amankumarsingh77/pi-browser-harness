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
import { createFakeClient, type FakeClient } from "../domains/fake-client";
import { fakeCtx, fakePi } from "../helpers/fake-pi";

const PIN: ProfilePin = { userDataDir: "/home/u/.config/google-chrome", profileDir: "Default", label: "Alice", savedAt: "" };

const ready: SetupDeps = {
  isBrowserRunning: () => Promise.resolve(true),
  ensureDaemon: () => Promise.resolve(true),
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
    registerSetupCommand(pi.pi, c.client, { ...ready, isBrowserRunning: () => Promise.resolve(false) });
    const ctx = fakeCtx();
    await pi.command("browser-setup").handler("", ctx.ctx);
    const notice = ctx.notices[0];
    assert.ok(notice);
    assert.equal(notice.type, "error");
    assert.match(notice.message, /No browser instance running/);
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

  test("no running browser stops before the daemon or the client are touched", async () => {
    const c = await setupClient();
    let daemonAsked = false;
    const r = await performSetup(c.client, undefined, {
      isBrowserRunning: () => Promise.resolve(false),
      ensureDaemon: () => { daemonAsked = true; return Promise.resolve(true); },
    });
    assert.equal(r.success, false);
    assert.equal(r.error, "No browser instance running. Please open your browser and then run /browser-setup.");
    assert.equal(daemonAsked, false);
    assert.equal(c.started(), 0);
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
