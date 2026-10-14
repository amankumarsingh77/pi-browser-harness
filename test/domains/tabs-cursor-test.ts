import { test } from "node:test";
import assert from "node:assert/strict";
import { listTabsTool, closeTabTool } from "../../src/domains/tabs";
import { createFakeClient } from "./fake-client";
import type { VirtualCursorController } from "../../src/cursor/types";
import { err, ok } from "../../src/util/result";
import { cdpError } from "../../src/cdp/errors";

type CursorProbe = VirtualCursorController & {
  readonly prunedWith: ReadonlyArray<ReadonlyArray<string>>;
  readonly forgotten: ReadonlyArray<string>;
};

const liveOwnedTargets = {
  targetInfos: [
    { targetId: "t1", type: "page", title: "one", url: "https://one.test" },
    { targetId: "t2", type: "page", title: "two", url: "https://two.test" },
  ],
};

const cursorProbe = (): CursorProbe => {
  const prunedWith: Array<ReadonlyArray<string>> = [];
  const forgotten: string[] = [];
  return {
    prunedWith,
    forgotten,
    runPointerAction: async () => {
      throw new Error("not used by tab tools");
    },
    withCaptureVisibility: async () => {
      throw new Error("not used by tab tools");
    },
    applySessionSettings: async () => {},
    status: () => ({ enabled: true, diagnostics: { status: "shown" } }),
    forget: async (targetId) => {
      forgotten.push(targetId);
    },
    prune: async (targetIds) => {
      prunedWith.push([...targetIds].sort());
    },
    clear: async () => {},
  };
};

test("list prunes cursor state to live owned targets", async () => {
  const fake = await createFakeClient({
    ownedTargetIds: ["t1", "t2"],
    canned: { "Target.getTargets": ok(liveOwnedTargets) },
    listTabs: [
      { targetId: "t1", title: "one", url: "https://one.test", owned: true },
      { targetId: "t2", title: "two", url: "https://two.test", owned: true },
      { targetId: "other", title: "other", url: "https://other.test", owned: false },
    ],
  });
  const cursor = cursorProbe();
  const result = await listTabsTool.handler({ scope: "owned" }, {
    client: fake.client,
    cursor,
    signal: undefined,
    onUpdate: () => {},
    extensionCtx: undefined as never,
  });

  assert.equal(result.success, true);
  assert.deepEqual(cursor.prunedWith, [["t1", "t2"]]);
});

test("close forgets cursor state only after Chrome confirms close", async () => {
  const fake = await createFakeClient({
    ownedTargetIds: ["t1", "t2"],
    canned: {
      "Target.getTargets": ok(liveOwnedTargets),
      "Target.closeTarget": ok({ success: true }),
    },
  });
  const cursor = cursorProbe();
  const result = await closeTabTool.handler({ targetId: "t2" }, {
    client: fake.client,
    cursor,
    signal: undefined,
    onUpdate: () => {},
    extensionCtx: undefined as never,
  });

  assert.equal(result.success, true);
  assert.deepEqual(cursor.forgotten, ["t2"]);
});

test("failed close preserves cursor state", async () => {
  const fake = await createFakeClient({
    ownedTargetIds: ["t1", "t2"],
    canned: { "Target.getTargets": ok(liveOwnedTargets) },
  });
  const client = {
    ...fake.client,
    closeTab: async () => err(cdpError("remote_error", "close failed")),
  };
  const cursor = cursorProbe();
  const result = await closeTabTool.handler({ targetId: "t2" }, {
    client,
    cursor,
    signal: undefined,
    onUpdate: () => {},
    extensionCtx: undefined as never,
  });

  assert.equal(result.success, false);
  assert.deepEqual(cursor.forgotten, []);
});
