import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "typebox";
import { daemonSocketMayExist, daemonSpawnCommand } from "../../src/daemon/spawn";
import { type AnyBrowserToolDefinition, registerBrowserTool } from "../../src/util/tool";
import type { BrowserClient } from "../../src/client";
import { ok } from "../../src/util/result";

const WINDOWS_PIPE = "\\\\.\\pipe\\pi-browser-daemon";
const MISSING_SOCKET = "/pi-browser-harness/definitely/not/here.sock";
const thisFile = fileURLToPath(import.meta.url);

describe("daemon socket presence check", () => {
  test("a Windows named pipe is never judged absent from the filesystem", async () => {
    assert.equal(await daemonSocketMayExist("win32", WINDOWS_PIPE), true);
  });

  test("a missing POSIX socket path is judged absent", async () => {
    assert.equal(await daemonSocketMayExist("linux", MISSING_SOCKET), false);
  });

  test("an existing POSIX path is judged present", async () => {
    assert.equal(await daemonSocketMayExist("linux", thisFile), true);
  });

  test("darwin uses the filesystem like linux", async () => {
    assert.equal(await daemonSocketMayExist("darwin", MISSING_SOCKET), false);
    assert.equal(await daemonSocketMayExist("darwin", thisFile), true);
  });
});

describe("daemon spawn command", () => {
  test("the daemon runs on this process's node, not a shell", () => {
    const spec = daemonSpawnCommand();
    assert.notEqual(spec, null);
    assert.equal(spec?.command, process.execPath);
  });

  test("the resolved tsx CLI is a real file on disk", () => {
    const cli = daemonSpawnCommand()?.args[0];
    assert.equal(typeof cli, "string");
    // A hoisted install puts tsx beside the package, so a `<pkg>/node_modules/.bin` guess would miss it.
    assert.equal(existsSync(String(cli)), true, `tsx CLI not found at ${String(cli)}`);
    assert.match(String(cli), /cli\.mjs$/);
  });

  test("the daemon entrypoint is passed to tsx", () => {
    const script = daemonSpawnCommand()?.args[1];
    assert.match(String(script), /[\\/]daemon[\\/]index\.ts$/);
    assert.equal(existsSync(String(script)), true);
  });
});

type GateProbe = { readonly ran: ReadonlyArray<string>; readonly text: string };

const runGate = async (ensureAlive: boolean | undefined): Promise<GateProbe> => {
  const ran: string[] = [];
  const client = {
    mutationMutex: () => ({ acquire: async () => () => {} }),
    ensureAlive: async () => ok(undefined),
  } as unknown as BrowserClient;
  const def = {
    name: "browser_probe",
    label: "Probe",
    description: "probe",
    promptSnippet: "probe",
    promptGuidelines: [],
    parameters: Type.Object({}),
    concurrency: "parallel",
    ...(ensureAlive !== undefined ? { ensureAlive } : {}),
    handler: async () => {
      ran.push("handler");
      return ok({ text: "done" });
    },
  } as AnyBrowserToolDefinition;

  let registered: ToolDefinition<TSchema> | undefined;
  const pi = {
    registerTool: (td: ToolDefinition<TSchema>) => {
      registered = td;
    },
  } as unknown as ExtensionAPI;
  registerBrowserTool(pi, client, def);
  assert.ok(registered, "tool was not registered");
  const result = await registered.execute?.("id", {}, undefined, undefined, undefined as never);
  const first = result?.content[0];
  return { ran, text: first !== undefined && first.type === "text" ? first.text : "" };
};

describe("tool gate on the daemon socket", () => {
  test("ensureAlive:false bypasses the gate entirely", async () => {
    const probe = await runGate(false);
    assert.deepEqual([...probe.ran], ["handler"]);
    assert.equal(probe.text, "done");
  });

  test("a gated tool agrees with the socket check about reaching the handler", async () => {
    const reachable = await daemonSocketMayExist();
    const probe = await runGate(undefined);
    if (reachable) assert.deepEqual([...probe.ran], ["handler"]);
    else {
      assert.deepEqual([...probe.ran], []);
      assert.match(probe.text, /not initialized/);
    }
  });
});
