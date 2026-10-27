import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createJournal } from "../../src/recipes/journal";
import { waitFor } from "../helpers/wait";

const DAY_MS = 24 * 60 * 60 * 1000;

const line = (run: number): string =>
  JSON.stringify({ v: 1, at: "2026-01-01T00:00:00.000Z", run, source: "agent", tool: "browser_reload", replayable: true, args: {}, password: false, url: "", ok: true });

describe("recipe journal file", () => {
  let dir: string;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-journal-test-"));
  });

  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  test("SC9: a journal reopened on a file holding runs 1 and 2 begins run 3, and the next entry carries run 3", async () => {
    writeFileSync(join(dir, "s-1.jsonl"), `${line(1)}\n${line(2)}\n`);
    const journal = createJournal(dir, "s-1");

    assert.equal(await journal.beginRun(), 3);
    await journal.append({ source: "agent", tool: "browser_reload", replayable: true, args: {}, password: false, url: "https://example.test/", ok: true });

    const entries = await journal.entries();
    assert.equal(entries.length, 3);
    assert.equal(entries[2]?.run, 3);
  });

  test("SC10: opening a journal deletes the .jsonl modified 31 days ago and keeps the one modified 2 days ago", async () => {
    const now = Date.now();
    const old = join(dir, "old.jsonl");
    const recent = join(dir, "recent.jsonl");
    writeFileSync(old, `${line(1)}\n`);
    writeFileSync(recent, `${line(1)}\n`);
    utimesSync(old, new Date(now - 31 * DAY_MS), new Date(now - 31 * DAY_MS));
    utimesSync(recent, new Date(now - 2 * DAY_MS), new Date(now - 2 * DAY_MS));

    createJournal(dir, "s-new", () => now);

    assert.equal(await waitFor(() => !existsSync(old)), true, "the 31-day-old journal was not deleted");
    assert.equal(existsSync(recent), true);
  });
});
