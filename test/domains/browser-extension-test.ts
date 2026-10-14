import { test } from "node:test";
import assert from "node:assert/strict";
import {
  AuthStorage,
  createEventBus,
  createExtensionRuntime,
  ExtensionRunner,
  ModelRegistry,
  SessionManager,
} from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "../../src/client";
import { createBrowserHarnessExtension } from "../../src/index";
import { createFakeClient } from "./fake-client";
import { createFakeCursor, type FakeCursor } from "../util/fake-cursor";
import { loadExtensionFromFactory } from "../../node_modules/@mariozechner/pi-coding-agent/dist/core/extensions/loader.js";

type EntryHarness = {
  readonly persisted: unknown[];
  readonly notifications: Array<{ readonly message: string; readonly level: string }>;
  readonly order: string[];
  readonly runner: ExtensionRunner;
  readonly client: BrowserClient;
  readonly cursor: FakeCursor;
  readonly namespace: () => string;
};

const createEntryHarness = async (
  hardDisabled = false,
  detachFails = false,
  recordCursorOrder = false,
): Promise<EntryHarness> => {
  const persisted: unknown[] = [];
  const notifications: Array<{ readonly message: string; readonly level: string }> = [];
  const order: string[] = [];
  const cursor = createFakeCursor(
    undefined,
    recordCursorOrder ? (call) => order.push(call) : undefined,
  );
  const fakeClient = await createFakeClient();
  const client: BrowserClient = {
    ...fakeClient.client,
    namespace: "test",
    setProfilePin: () => {},
    detach: async () => {
      order.push("detach");
      if (detachFails) throw new Error("detach failed");
    },
    closeOwnedTabs: async () => {
      order.push("close-owned");
    },
  };
  const runtime = createExtensionRuntime();
  runtime.flagValues.set("no-browser-cursor", hardDisabled);
  runtime.appendEntry = (_type, data) => {
    persisted.push(data);
  };
  let namespace: string | undefined;
  const extension = await loadExtensionFromFactory(
    (pi) => createBrowserHarnessExtension(pi, {
      createClient: (options) => {
        namespace = options.namespace;
        return client;
      },
      createCursor: () => cursor,
      readProfilePin: async () => null,
    }),
    process.cwd(),
    createEventBus(),
    runtime,
  );
  const sessionManager = SessionManager.inMemory(process.cwd());
  sessionManager.appendCustomEntry("browser-harness-state", {
    namespace: "test",
    cursorEnabled: false,
  });
  const runner = new ExtensionRunner(
    [extension],
    runtime,
    process.cwd(),
    sessionManager,
    ModelRegistry.inMemory(AuthStorage.inMemory()),
  );
  runner.setUIContext({
    ...runner.getUIContext(),
    notify: (message, level = "info") => {
      notifications.push({ message, level });
    },
  });

  return {
    persisted,
    notifications,
    order,
    runner,
    client,
    cursor,
    namespace: () => {
      if (namespace === undefined) throw new Error("browser client was not created");
      return namespace;
    },
  };
};

test("registers the cursor flag and command", async () => {
  const harness = await createEntryHarness();

  assert.ok(harness.runner.getCommand("browser-cursor"));
});

test("cursor command applies on and off, then reports status", async () => {
  const harness = await createEntryHarness();
  const command = harness.runner.getCommand("browser-cursor");
  assert.ok(command);
  await harness.runner.emit({ type: "session_start", reason: "startup" });
  await command.handler("on", harness.runner.createCommandContext());
  await command.handler("off", harness.runner.createCommandContext());
  await command.handler("status", harness.runner.createCommandContext());

  assert.deepEqual(harness.cursor.appliedSettings, [false, true, false]);
  assert.deepEqual(harness.persisted, [
    { namespace: harness.namespace(), cursorEnabled: true, ownedTargetIds: [] },
    { namespace: harness.namespace(), cursorEnabled: false, ownedTargetIds: [] },
  ]);
  assert.deepEqual(harness.notifications, [
    { message: "Virtual cursor: on", level: "info" },
    { message: "Virtual cursor: off", level: "info" },
    { message: "Virtual cursor: off", level: "info" },
  ]);
});

test("hard-disable rejects on without overwriting the saved preference", async () => {
  const harness = await createEntryHarness(true);
  const command = harness.runner.getCommand("browser-cursor");
  assert.ok(command);
  await harness.runner.emit({ type: "session_start", reason: "startup" });
  await command.handler("on", harness.runner.createCommandContext());

  assert.deepEqual(harness.cursor.appliedSettings, [false]);
  assert.deepEqual(harness.persisted, []);
  assert.deepEqual(harness.notifications, [{
    message: "Virtual cursor: forced off by --no-browser-cursor",
    level: "warning",
  }]);
});

test("session restore applies saved cursor settings on start and tree", async () => {
  const harness = await createEntryHarness();
  await harness.runner.emit({ type: "session_start", reason: "startup" });
  await harness.runner.emit({ type: "session_tree", newLeafId: null, oldLeafId: null });

  assert.deepEqual(harness.cursor.appliedSettings, [false, false]);
});

test("shutdown closes owned tabs before clearing cursor state", async () => {
  const harness = await createEntryHarness(false, false, true);
  await harness.runner.emit({ type: "session_start", reason: "startup" });
  harness.cursor.calls.length = 0;
  harness.order.length = 0;
  await harness.runner.emit({ type: "session_shutdown", reason: "quit" });

  assert.deepEqual(harness.order, ["detach", "close-owned", "clear"]);
  assert.deepEqual(harness.cursor.calls, ["clear"]);
});

test("shutdown still attempts owned tab closure when detach fails", async () => {
  const harness = await createEntryHarness(false, true, true);
  await harness.runner.emit({ type: "session_start", reason: "startup" });
  harness.order.length = 0;
  await harness.runner.emit({ type: "session_shutdown", reason: "quit" });

  assert.deepEqual(harness.order, ["detach", "close-owned", "clear"]);
});
