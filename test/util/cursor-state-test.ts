import { test } from "node:test";
import assert from "node:assert/strict";
import type { CustomEntry, ExtensionContext } from "@mariozechner/pi-coding-agent";
import { restoreState } from "../../src/state";

const contextWithState = (data: Record<string, unknown>): ExtensionContext => {
  const entry: CustomEntry = {
    type: "custom",
    id: "entry-1",
    parentId: null,
    timestamp: "2026-10-14T00:00:00.000Z",
    customType: "browser-harness-state",
    data,
  };
  return {
    sessionManager: { getBranch: () => [entry] },
  } as ExtensionContext;
};

test("old browser state defaults cursorEnabled to true", () => {
  const restored = restoreState(contextWithState({
    namespace: "n1",
    ownedTargetIds: ["t1"],
  }), "n1");
  assert.equal(restored.cursorEnabled, true);
});

test("an explicit saved false survives restore", () => {
  const restored = restoreState(contextWithState({
    namespace: "n1",
    cursorEnabled: false,
  }), "n1");
  assert.equal(restored.cursorEnabled, false);
});
