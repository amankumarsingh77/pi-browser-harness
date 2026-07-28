import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { fileURLToPath } from "node:url";
import { Type } from "typebox";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { TSchema } from "typebox";
import { daemonSocketMayExist } from "../../src/daemon/spawn";
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
