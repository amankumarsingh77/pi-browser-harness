/**
 * Unit tests for browser-process parsing and candidate ranking — no browser.
 *
 * Ranking exists because a machine can run several Chromium browsers at once.
 * Picking the wrong one means launching a profile window into a browser the
 * harness is not connected to: the agent sees nothing, and a browser the user
 * never pointed us at gets a new window. (That is exactly what happened during
 * development before ranking existed.)
 *
 * Run: npm test
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import {
  parseUserDataDirFlag,
  rankBrowserCandidate,
  resolveBrowserExecutable,
  spawnableExePath,
  stripDeletedSuffix,
} from "../../src/profile/browser-process";

describe("browser-process parsing and candidate ranking", () => {
  // B1: --user-data-dir parsing
  test("B1: bare value parsed", () => {
    assert.equal(parseUserDataDirFlag("/opt/google/chrome/chrome --user-data-dir=/tmp/x --foo"), "/tmp/x");
  });

  test("B1: double-quoted value with spaces parsed", () => {
    assert.equal(
      parseUserDataDirFlag('chrome.exe --user-data-dir="C:\\Users\\Some Name\\Data" --bar'),
      "C:\\Users\\Some Name\\Data",
    );
  });

  test("B1: single-quoted value parsed", () => {
    assert.equal(parseUserDataDirFlag("chrome --user-data-dir='/home/u/my dir'"), "/home/u/my dir");
  });

  test("B1: absent flag → undefined", () => {
    assert.equal(parseUserDataDirFlag("/opt/google/chrome/chrome"), undefined);
  });

  test("B1: empty value → undefined", () => {
    assert.equal(parseUserDataDirFlag("chrome --user-data-dir="), undefined);
  });

  // B2: an explicit --user-data-dir is decisive in both directions
  test("B2: exact user-data-dir match outranks a flagless process", () => {
    const target = "/tmp/pi-e2e-abc";
    const match = rankBrowserCandidate({ exePath: "/opt/google/chrome/chrome", explicitUserDataDir: target }, target);
    const noFlag = rankBrowserCandidate({ exePath: "/opt/google/chrome/chrome" }, target);
    assert.ok(match > noFlag);
  });

  test("B2: a DIFFERENT explicit user-data-dir ranks below a flagless process", () => {
    const target = "/tmp/pi-e2e-abc";
    const other = rankBrowserCandidate(
      { exePath: "/opt/google/chrome/chrome", explicitUserDataDir: "/tmp/somewhere-else" },
      target,
    );
    const noFlag = rankBrowserCandidate({ exePath: "/opt/google/chrome/chrome" }, target);
    assert.ok(other < noFlag);
  });

  test("B2: a different explicit dir is disqualified outright", () => {
    const target = "/tmp/pi-e2e-abc";
    const other = rankBrowserCandidate(
      { exePath: "/opt/google/chrome/chrome", explicitUserDataDir: "/tmp/somewhere-else" },
      target,
    );
    assert.equal(other, 0);
  });

  // B3: browser family match decides between flagless processes
  test("B3: Brave wins for a Brave user-data-dir", () => {
    const braveDir = join(homedir(), ".config/BraveSoftware/Brave-Browser");
    const brave = rankBrowserCandidate({ exePath: "/usr/bin/brave-browser" }, braveDir);
    const chrome = rankBrowserCandidate({ exePath: "/opt/google/chrome/chrome" }, braveDir);
    assert.ok(brave > chrome);
  });

  test("B3: Chrome wins for a Chrome user-data-dir", () => {
    const chromeDir = join(homedir(), ".config/google-chrome");
    assert.ok(
      rankBrowserCandidate({ exePath: "/opt/google/chrome/chrome" }, chromeDir) >
        rankBrowserCandidate({ exePath: "/usr/bin/brave-browser" }, chromeDir),
    );
  });

  test("B3: Chromium is not mistaken for Chrome", () => {
    const chromiumDir = join(homedir(), ".config/chromium");
    assert.ok(
      rankBrowserCandidate({ exePath: "/usr/bin/chromium" }, chromiumDir) >
        rankBrowserCandidate({ exePath: "/opt/google/chrome/chrome" }, chromiumDir),
    );
  });

  // B4: no preference expressed → every candidate is equally acceptable
  test("B4: without a target dir, candidates rank equally", () => {
    assert.equal(
      rankBrowserCandidate({ exePath: "/usr/bin/brave-browser" }),
      rankBrowserCandidate({ exePath: "/opt/google/chrome/chrome" }),
    );
  });

  // B5: Windows path comparison ignores case and separator style
  test("B5 win: case and separator differences still match", { skip: process.platform !== "win32" }, () => {
    assert.equal(
      rankBrowserCandidate(
        {
          exePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe",
          explicitUserDataDir: "C:\\Users\\U\\Data",
        },
        "c:/users/u/data",
      ),
      4,
    );
  });

  // B6: Linux's deleted-binary marker. An in-place `google-chrome` upgrade
  // unlinks the running binary, after which /proc/<pid>/exe reads
  // "…/chrome (deleted)" — a path spawn() rejects with ENOENT.
  test("B6: marker stripped from a replaced binary's path", () => {
    assert.equal(stripDeletedSuffix("/opt/google/chrome/chrome (deleted)"), "/opt/google/chrome/chrome");
  });

  test("B6: unmarked path left alone", () => {
    assert.equal(stripDeletedSuffix("/opt/google/chrome/chrome"), undefined);
  });

  test("B6: marker alone is not a path", () => {
    assert.equal(stripDeletedSuffix(" (deleted)"), undefined);
  });

  // B7: only a path that is actually on disk may be handed on as spawnable.
  describe("B7", () => {
    let root: string;
    let real: string;
    let literal: string;

    before(() => {
      root = mkdtempSync(join(tmpdir(), "pi-exe-"));
      real = join(root, "chrome");
      writeFileSync(real, "#!/bin/sh\n");
      chmodSync(real, 0o755);
    });

    after(() => {
      rmSync(root, { recursive: true, force: true });
    });

    test("B7: an existing path is returned unchanged", async () => {
      assert.equal(await spawnableExePath(real), real);
    });

    test("B7: a replaced binary resolves to the live install path", async () => {
      assert.equal(await spawnableExePath(`${real} (deleted)`), real);
    });

    test("B7: a missing path yields undefined", async () => {
      assert.equal(await spawnableExePath(join(root, "absent")), undefined);
    });

    test("B7: an empty path yields undefined", async () => {
      assert.equal(await spawnableExePath(""), undefined);
    });

    // The launch gate must never pass on a path it cannot spawn — that is
    // what produced a 15s "couldn't open a window" timeout instead of a
    // named error.
    test("B7: resolveBrowserExecutable repairs a replaced-binary path", async () => {
      assert.equal(await resolveBrowserExecutable({ running: true, exePath: `${real} (deleted)` }), real);
    });

    test(
      "B7: an unspawnable path is not passed on as usable",
      { skip: process.platform === "win32" },
      async () => {
        assert.equal(await resolveBrowserExecutable({ running: true, exePath: join(root, "absent") }), undefined);
      },
    );

    // A binary genuinely named "… (deleted)" must win over the stripped form.
    // Created last, so the checks above see only the ordinary case.
    test("B7: a real file named '… (deleted)' is preferred over stripping", async () => {
      literal = join(root, "chrome (deleted)");
      writeFileSync(literal, "#!/bin/sh\n");
      chmodSync(literal, 0o755);
      assert.equal(await spawnableExePath(literal), literal);
    });
  });
});
