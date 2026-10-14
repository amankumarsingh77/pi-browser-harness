import { test } from "node:test";
import assert from "node:assert/strict";
import type {
  BrowserClient,
} from "../src/client";
import type {
  CustomEntry,
  ExtensionAPI,
  ExtensionCommandContext,
  ExtensionContext,
  RegisteredCommand,
} from "@mariozechner/pi-coding-agent";
import { createBrowserHarnessExtension } from "../src/index";
import { createFakeCursor } from "./util/fake-cursor";

type EntryHarness = {
  readonly commands: ReadonlyMap<string, Omit<RegisteredCommand, "name" | "sourceInfo">>;
  readonly events: ReadonlyMap<string, (event: never, ctx: ExtensionContext) => Promise<void> | void>;
  readonly persisted: unknown[];
  readonly notifications: Array<{ readonly message: string; readonly level: string }>;
  readonly order: string[];
  readonly pi: ExtensionAPI;
  readonly commandContext: ExtensionCommandContext;
  readonly sessionContext: ExtensionContext;
  readonly client: BrowserClient;
};

const createEntryHarness = (hardDisabled = false, detachFails = false): EntryHarness => {
  const commands = new Map<string, Omit<RegisteredCommand, "name" | "sourceInfo">>();
  const events = new Map<string, (event: never, ctx: ExtensionContext) => Promise<void> | void>();
  const persisted: unknown[] = [];
  const notifications: Array<{ readonly message: string; readonly level: string }> = [];
  const order: string[] = [];
  const entry: CustomEntry = {
    type: "custom",
    id: "state-1",
    parentId: null,
    timestamp: "2026-10-14T00:00:00.000Z",
    customType: "browser-harness-state",
    data: { namespace: "test", cursorEnabled: false },
  };
  const pi = {
    getFlag: (name: string) => {
      if (name === "no-browser-cursor") return hardDisabled;
      if (name === "browser-namespace") return "test";
      return undefined;
    },
    registerFlag: () => {},
    registerCommand: (name: string, command: Omit<RegisteredCommand, "name" | "sourceInfo">) => {
      commands.set(name, command);
    },
    on: (event: string, handler: (event: never, ctx: ExtensionContext) => Promise<void> | void) => {
      events.set(event, handler);
    },
    appendEntry: (_type: string, data: unknown) => {
      persisted.push(data);
    },
    registerTool: () => {},
  } as unknown as ExtensionAPI;
  const client = {
    namespace: "test",
    setProfilePin: () => {},
    detach: async () => {
      order.push("detach");
      if (detachFails) throw new Error("detach failed");
    },
    closeOwnedTabs: async () => {
      order.push("close-owned");
    },
  } as unknown as BrowserClient;

  return {
    commands,
    events,
    persisted,
    notifications,
    order,
    pi,
    commandContext: {
      ui: { notify: (message: string, level: string) => notifications.push({ message, level }) },
    } as unknown as ExtensionCommandContext,
    sessionContext: {
      sessionManager: { getBranch: () => [entry] },
    } as unknown as ExtensionContext,
    client,
  };
};

test("registers the cursor flag and command", () => {
  const harness = createEntryHarness();
  createBrowserHarnessExtension(harness.pi, {
    createClient: () => harness.client,
    readProfilePin: async () => null,
  });

  assert.ok(harness.commands.has("browser-cursor"));
});

test("cursor command applies on and off, then reports status", async () => {
  const harness = createEntryHarness();
  const cursor = createFakeCursor();
  createBrowserHarnessExtension(harness.pi, {
    createClient: () => harness.client,
    createCursor: () => cursor,
    readProfilePin: async () => null,
  });
  const start = harness.events.get("session_start");
  assert.ok(start);
  await start({ type: "session_start" } as never, harness.sessionContext);

  const command = harness.commands.get("browser-cursor");
  assert.ok(command);
  await command.handler("on", harness.commandContext);
  await command.handler("off", harness.commandContext);
  await command.handler("status", harness.commandContext);

  assert.deepEqual(cursor.appliedSettings, [false, true, false]);
  assert.deepEqual(harness.persisted, [
    { namespace: "test", cursorEnabled: true, ownedTargetIds: [] },
    { namespace: "test", cursorEnabled: false, ownedTargetIds: [] },
  ]);
  assert.deepEqual(harness.notifications, [
    { message: "Virtual cursor: on", level: "info" },
    { message: "Virtual cursor: off", level: "info" },
    { message: "Virtual cursor: on", level: "info" },
  ]);
});

test("hard-disable rejects on without overwriting the saved preference", async () => {
  const harness = createEntryHarness(true);
  const cursor = createFakeCursor();
  createBrowserHarnessExtension(harness.pi, {
    createClient: () => harness.client,
    createCursor: () => cursor,
    readProfilePin: async () => null,
  });
  const start = harness.events.get("session_start");
  const command = harness.commands.get("browser-cursor");
  assert.ok(start);
  assert.ok(command);
  await start({ type: "session_start" } as never, harness.sessionContext);
  await command.handler("on", harness.commandContext);

  assert.deepEqual(cursor.appliedSettings, [false]);
  assert.deepEqual(harness.persisted, []);
  assert.deepEqual(harness.notifications, [{
    message: "Virtual cursor: forced off by --no-browser-cursor",
    level: "warning",
  }]);
});

test("session restore applies saved cursor settings on start and tree", async () => {
  const harness = createEntryHarness();
  const cursor = createFakeCursor();
  createBrowserHarnessExtension(harness.pi, {
    createClient: () => harness.client,
    createCursor: () => cursor,
    readProfilePin: async () => null,
  });

  const start = harness.events.get("session_start");
  const tree = harness.events.get("session_tree");
  assert.ok(start);
  assert.ok(tree);
  await start({ type: "session_start" } as never, harness.sessionContext);
  await tree({ type: "session_tree" } as never, harness.sessionContext);

  assert.deepEqual(cursor.appliedSettings, [false, false]);
});

test("shutdown closes owned tabs before clearing cursor state", async () => {
  const harness = createEntryHarness();
  const cursor = createFakeCursor(undefined, (call) => harness.order.push(call));
  createBrowserHarnessExtension(harness.pi, {
    createClient: () => harness.client,
    createCursor: () => cursor,
    readProfilePin: async () => null,
  });

  const start = harness.events.get("session_start");
  const shutdown = harness.events.get("session_shutdown");
  assert.ok(start);
  assert.ok(shutdown);
  await start({ type: "session_start" } as never, harness.sessionContext);
  cursor.calls.length = 0;
  harness.order.length = 0;
  await shutdown({ type: "session_shutdown" } as never, harness.sessionContext);

  assert.deepEqual(harness.order, ["detach", "close-owned", "clear"]);
  assert.deepEqual(cursor.calls, ["clear"]);
});

test("shutdown still attempts owned tab closure when detach fails", async () => {
  const harness = createEntryHarness(false, true);
  const cursor = createFakeCursor(undefined, (call) => harness.order.push(call));
  createBrowserHarnessExtension(harness.pi, {
    createClient: () => harness.client,
    createCursor: () => cursor,
    readProfilePin: async () => null,
  });

  const start = harness.events.get("session_start");
  const shutdown = harness.events.get("session_shutdown");
  assert.ok(start);
  assert.ok(shutdown);
  await start({ type: "session_start" } as never, harness.sessionContext);
  harness.order.length = 0;
  await shutdown({ type: "session_shutdown" } as never, harness.sessionContext);

  assert.deepEqual(harness.order, ["detach", "close-owned", "clear"]);
});
