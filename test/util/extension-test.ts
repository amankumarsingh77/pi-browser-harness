import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DEFAULT_MAX_LINES } from "@mariozechner/pi-coding-agent";
import browserHarnessExtension, { createExtension } from "../../src/index";
import type { BrowserClient, BrowserClientOptions } from "../../src/client";
import type { ProfilePin } from "../../src/profile/store";
import { ALL_TOOLS } from "../../src/registry";
import { applyTruncation } from "../../src/util/truncate";
import { asString, isRecord } from "../../src/util/guards";
import { createFakeClient, createStubTransport } from "../domains/fake-client";
import { fakeCtx, fakePi } from "../helpers/fake-pi";

// test/domains/extension-registration-test.ts covers the third-party tool seam and that contributed
// tools reach pi on session_start. This file covers the extension's own wiring: flags, commands,
// event subscriptions, lazy flag reads, idempotent registration and shutdown cleanup.
//
// With the default export, session_start builds a real BrowserClient over the daemon transport.
// Neither connects at construction (the transport dials only on connect(), which start() alone
// triggers), so the socket is never touched here. The namespace and client lifetime are asserted
// through createExtension's injectable transport/client/pin factories further down.

const load = () => {
  const pi = fakePi();
  browserHarnessExtension(pi.pi);
  return pi;
};

describe("browser harness extension", () => {
  let agentDir: string;
  let savedAgentDir: string | undefined;

  // session_start re-reads the on-disk profile pin; keep it off the developer's real one.
  before(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-ext-test-"));
    savedAgentDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
  });

  after(() => {
    if (savedAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
    else process.env["PI_CODING_AGENT_DIR"] = savedAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  // The tool registry is a process-wide singleton (one per loaded module), so tools reach pi on the
  // first session_start of this process only. This test therefore runs first and owns that claim.
  test("registers no tools before session_start and every built-in exactly once after, even across repeated session_starts", async () => {
    const pi = load();
    assert.equal(pi.tools.length, 0);
    await pi.emit("session_start", { type: "session_start" }, fakeCtx().ctx);
    for (const tool of ALL_TOOLS) assert.ok(pi.tools.includes(tool.name), `${tool.name} not registered`);
    assert.equal(new Set(pi.tools).size, pi.tools.length, "a tool was registered twice");
    const toolsAfterFirst = pi.tools.length;
    const commandsAfterFirst = pi.commands.length;
    await pi.emit("session_start", { type: "session_start" }, fakeCtx().ctx);
    assert.equal(pi.tools.length, toolsAfterFirst, "tools were re-registered");
    // registerSetupCommand / registerProfileCommand run on every session_start; pi replaces a
    // command registered under the same name, so this documents what reaches pi rather than guarding it.
    assert.equal(pi.commands.length, commandsAfterFirst + 2);
  });

  test("registers the namespace and debug-click flags at load", () => {
    const pi = load();
    assert.deepEqual(pi.flags, [
      { name: "browser-namespace", type: "string", defaultValue: undefined },
      { name: "browser-debug-clicks", type: "boolean", defaultValue: false },
    ]);
  });

  test("registers the status and reload commands at load, and setup/profile only once a session starts", async () => {
    const pi = load();
    assert.deepEqual(pi.commands.map((c) => c.name), ["browser-status", "browser-reload-daemon"]);
    for (const c of pi.commands) assert.ok(c.description, `${c.name} has no description`);
    await pi.emit("session_start", { type: "session_start" }, fakeCtx().ctx);
    assert.deepEqual(pi.commands.map((c) => c.name), ["browser-status", "browser-reload-daemon", "browser-setup", "browser-profile"]);
  });

  test("subscribes to the session lifecycle and the agent prompt", () => {
    const pi = load();
    assert.deepEqual([...pi.events].sort(), ["before_agent_start", "session_shutdown", "session_start", "session_tree"]);
  });

  test("does not read flags at load, only once a session starts", async () => {
    const pi = load();
    assert.equal(pi.flagReads.length, 0);
    await pi.emit("session_start", { type: "session_start" }, fakeCtx().ctx);
    assert.ok(pi.flagReads.includes("browser-namespace"));
    assert.ok(pi.flagReads.includes("browser-debug-clicks"));
  });


  test("browser-status before any session warns instead of touching a client", async () => {
    const pi = load();
    const ctx = fakeCtx();
    await pi.command("browser-status").handler("", ctx.ctx);
    assert.deepEqual(ctx.notices, [{ message: "Browser client not started. Run /browser-setup first.", type: "warning" }]);
  });

  test("browser-reload-daemon before any session warns instead of restarting", async () => {
    const pi = load();
    const ctx = fakeCtx();
    await pi.command("browser-reload-daemon").handler("", ctx.ctx);
    assert.deepEqual(ctx.notices, [{ message: "Browser client not started.", type: "warning" }]);
  });

  test("browser-status after session_start reports a disconnected browser and the missing profile", async () => {
    const pi = load();
    await pi.emit("session_start", { type: "session_start" }, fakeCtx().ctx);
    const ctx = fakeCtx();
    await pi.command("browser-status").handler("", ctx.ctx);
    const message = ctx.notices[0]?.message ?? "";
    assert.equal(ctx.notices[0]?.type, "info");
    assert.match(message, /Browser: .*Disconnected/);
    assert.match(message, /Profile: not selected/);
    assert.match(message, /Session: none/);
    assert.ok(!message.includes("Current Page"), "no page block without a connection");
  });

  test("before_agent_start appends the browser guidance to the host prompt", async () => {
    const pi = load();
    const result = await pi.emit("before_agent_start", { type: "before_agent_start", systemPrompt: "HOST PROMPT." }, fakeCtx().ctx);
    assert.ok(isRecord(result));
    const prompt = asString(result["systemPrompt"]) ?? "";
    assert.ok(prompt.startsWith("HOST PROMPT."));
    assert.ok(prompt.length > "HOST PROMPT.".length, "nothing was appended");
    assert.match(prompt, /browser_/);
  });

  test("session_shutdown without a client still removes spilled output directories", async () => {
    const pi = load();
    const spilled = await applyTruncation("x\n".repeat(DEFAULT_MAX_LINES + 1), "ext-shutdown");
    assert.ok(spilled.fullOutputPath);
    assert.ok(existsSync(dirname(spilled.fullOutputPath)));
    await pi.emit("session_shutdown", { type: "session_shutdown" }, fakeCtx().ctx);
    assert.equal(existsSync(dirname(spilled.fullOutputPath)), false);
    assert.equal(pi.entries.length, 0, "nothing to persist without a session");
  });

  test("session_shutdown after session_start tears down without connecting or persisting an unchanged state", async () => {
    const pi = load();
    await pi.emit("session_start", { type: "session_start" }, fakeCtx().ctx);
    const spilled = await applyTruncation("y\n".repeat(DEFAULT_MAX_LINES + 1), "ext-shutdown-2");
    assert.ok(spilled.fullOutputPath);
    await pi.emit("session_shutdown", { type: "session_shutdown" }, fakeCtx().ctx);
    assert.equal(existsSync(dirname(spilled.fullOutputPath)), false);
    assert.equal(pi.entries.length, 0, "the restored snapshot must not be appended again");
  });

  test("session_start restores ownership from the branch without re-appending it", async () => {
    const pi = load();
    const ctx = fakeCtx({
      branch: [
        { type: "custom", customType: "browser-harness-state", data: { namespace: "old", ownedTargetIds: ["tab-1"], harnessWindowTargetId: "tab-1" } },
      ],
    });
    await pi.emit("session_start", { type: "session_start" }, ctx.ctx);
    await pi.emit("session_tree", { type: "session_tree" }, ctx.ctx);
    assert.equal(pi.entries.length, 0);
  });
});

// createExtension with recorders in place of the daemon transport, the client factory and the
// on-disk pin, so the namespace handed to the transport and the client's lifetime are observable.
type Wired = {
  readonly pi: ReturnType<typeof fakePi>;
  readonly transports: ReadonlyArray<string>;
  readonly clientOpts: ReadonlyArray<BrowserClientOptions>;
  readonly pins: ReadonlyArray<ProfilePin | null>;
  readonly pinReads: () => number;
};

const PIN: ProfilePin = { userDataDir: "/home/u/.config/google-chrome", profileDir: "Default", label: "Alice", savedAt: "" };

const wire = async (opts: { readonly pin?: ProfilePin | null } = {}): Promise<Wired> => {
  const fake = await createFakeClient();
  const transports: string[] = [];
  const clientOpts: BrowserClientOptions[] = [];
  const pins: Array<ProfilePin | null> = [];
  let pinReads = 0;
  const client: BrowserClient = { ...fake.client, setProfilePin: (pin) => { pins.push(pin); } };
  const extension = createExtension({
    createTransport: (namespace) => {
      transports.push(namespace);
      return createStubTransport().transport;
    },
    createClient: (o) => {
      clientOpts.push(o);
      return client;
    },
    readPin: () => {
      pinReads++;
      return Promise.resolve(opts.pin ?? null);
    },
  });
  const pi = fakePi();
  extension(pi.pi);
  return { pi, transports, clientOpts, pins, pinReads: () => pinReads };
};

describe("createExtension wiring", () => {
  test("the --browser-namespace flag value is the namespace handed to the transport and the client", async () => {
    const w = await wire();
    w.pi.setFlag("browser-namespace", "team-alpha");
    await w.pi.emit("session_start", { type: "session_start" }, fakeCtx().ctx);
    assert.deepEqual(w.transports, ["team-alpha"]);
    assert.equal(w.clientOpts[0]?.namespace, "team-alpha");
  });

  test("without the flag the namespace is a random pi- prefixed 8-character id, resolved once", async () => {
    const w = await wire();
    await w.pi.emit("session_start", { type: "session_start" }, fakeCtx().ctx);
    await w.pi.emit("session_tree", { type: "session_tree" }, fakeCtx().ctx);
    const namespace = w.transports[0];
    assert.ok(namespace !== undefined);
    assert.match(namespace, /^pi-[a-z0-9]{8}$/);
    assert.equal(w.clientOpts[0]?.namespace, namespace);
    const other = await wire();
    await other.pi.emit("session_start", { type: "session_start" }, fakeCtx().ctx);
    assert.notEqual(other.transports[0], namespace, "each extension instance draws its own id");
  });

  test("the client is created once across two session_starts and the second re-applies the on-disk pin", async () => {
    const w = await wire({ pin: PIN });
    await w.pi.emit("session_start", { type: "session_start" }, fakeCtx().ctx);
    assert.equal(w.clientOpts.length, 1);
    assert.equal(w.transports.length, 1);
    assert.deepEqual(w.clientOpts[0]?.profilePin, PIN, "the first start passes the pin to the factory");
    assert.deepEqual(w.pins, [], "the factory, not setProfilePin, receives the first pin");
    await w.pi.emit("session_start", { type: "session_start" }, fakeCtx().ctx);
    assert.equal(w.clientOpts.length, 1, "a second session_start must reuse the client");
    assert.equal(w.transports.length, 1);
    assert.deepEqual(w.pins, [PIN], "the second start re-reads the pin and applies it to the live client");
    assert.equal(w.pinReads(), 2);
  });

  test("restored ownership from the branch reaches the client factory", async () => {
    const w = await wire();
    const ctx = fakeCtx({
      branch: [
        { type: "custom", customType: "browser-harness-state", data: { namespace: "old", ownedTargetIds: ["tab-1"], harnessWindowTargetId: "tab-1", harnessWindowId: 3 } },
      ],
    });
    await w.pi.emit("session_start", { type: "session_start" }, ctx.ctx);
    assert.deepEqual(w.clientOpts[0]?.initialOwnership, { ownedTargetIds: ["tab-1"], harnessWindowTargetId: "tab-1", harnessWindowId: 3 });
  });

  test("browser-status after session_start reports the injected client's pin", async () => {
    const w = await wire({ pin: PIN });
    await w.pi.emit("session_start", { type: "session_start" }, fakeCtx().ctx);
    const ctx = fakeCtx();
    await w.pi.command("browser-status").handler("", ctx.ctx);
    assert.match(ctx.notices[0]?.message ?? "", /Browser: .*Connected/);
  });
});
