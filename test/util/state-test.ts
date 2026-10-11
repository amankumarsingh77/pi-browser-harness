import { test, describe } from "node:test";
import assert from "node:assert/strict";
import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { type BrowserState, createStatePersister, defaultState } from "../../src/state";

// Pi session JSONL is append-only, so every appendEntry is permanent. Issue #26: identical
// snapshots were appended on every ownership callback, session_tree and shutdown, growing the
// session file and the branch navigator's "+N custom" chain without bound.
const fakePi = (): { readonly pi: ExtensionAPI; readonly entries: ReadonlyArray<unknown> } => {
  const entries: unknown[] = [];
  const pi = {
    appendEntry: (_customType: string, data?: unknown) => {
      entries.push(data);
    },
  } as unknown as ExtensionAPI;
  return { pi, entries };
};

const owned = (...ids: string[]): BrowserState => ({ namespace: "default", ownedTargetIds: ids });

describe("state persister", () => {
  test("repeated identical snapshots produce one entry", () => {
    const { pi, entries } = fakePi();
    const persister = createStatePersister(pi);
    assert.equal(persister.persist(owned("a")), true);
    assert.equal(persister.persist(owned("a")), false);
    assert.equal(persister.persist(owned("a")), false);
    assert.equal(entries.length, 1);
  });

  test("a changed snapshot is appended, and the same change twice is not", () => {
    const { pi, entries } = fakePi();
    const persister = createStatePersister(pi);
    persister.persist(owned("a"));
    persister.persist(owned("a", "b"));
    persister.persist(owned("a", "b"));
    persister.persist(owned("a"));
    assert.deepEqual(entries.map((e) => (e as BrowserState).ownedTargetIds), [["a"], ["a", "b"], ["a"]]);
  });

  test("tab order does not count as a change", () => {
    const { pi, entries } = fakePi();
    const persister = createStatePersister(pi);
    persister.persist(owned("a", "b"));
    persister.persist(owned("b", "a"));
    assert.equal(entries.length, 1);
  });

  test("a state restored from the session is not re-appended until it changes", () => {
    const { pi, entries } = fakePi();
    const persister = createStatePersister(pi);
    persister.markPersisted(owned("a"));
    assert.equal(persister.persist(owned("a")), false);
    assert.equal(entries.length, 0);
    assert.equal(persister.persist(owned("a", "b")), true);
    assert.equal(entries.length, 1);
  });

  test("the window ids are part of the comparison", () => {
    const { pi, entries } = fakePi();
    const persister = createStatePersister(pi);
    persister.persist({ ...owned("a"), harnessWindowTargetId: "w1", harnessWindowId: 7 });
    persister.persist({ ...owned("a"), harnessWindowTargetId: "w1", harnessWindowId: 7 });
    persister.persist({ ...owned("a"), harnessWindowTargetId: "w2", harnessWindowId: 8 });
    assert.equal(entries.length, 2);
  });

  test("the default state is persisted once, then skipped", () => {
    const { pi, entries } = fakePi();
    const persister = createStatePersister(pi);
    assert.equal(persister.persist(defaultState()), true);
    assert.equal(persister.persist(defaultState()), false);
    assert.equal(entries.length, 1);
  });
});
