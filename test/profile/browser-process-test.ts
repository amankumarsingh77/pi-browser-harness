/**
 * Unit tests for browser-process parsing and candidate ranking — no browser.
 *
 * Ranking exists because a machine can run several Chromium browsers at once.
 * Picking the wrong one means launching a profile window into a browser the
 * harness is not connected to: the agent sees nothing, and a browser the user
 * never pointed us at gets a new window. (That is exactly what happened during
 * development before ranking existed.)
 *
 * Run: npx tsx test/profile/browser-process-test.ts
 */
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

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string): void => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
};

async function main(): Promise<void> {
  // B1: --user-data-dir parsing
  {
    check(
      parseUserDataDirFlag("/opt/google/chrome/chrome --user-data-dir=/tmp/x --foo") === "/tmp/x",
      "B1: bare value parsed",
    );
    check(
      parseUserDataDirFlag('chrome.exe --user-data-dir="C:\\Users\\Some Name\\Data" --bar') ===
        "C:\\Users\\Some Name\\Data",
      "B1: double-quoted value with spaces parsed",
    );
    check(
      parseUserDataDirFlag("chrome --user-data-dir='/home/u/my dir'") === "/home/u/my dir",
      "B1: single-quoted value parsed",
    );
    check(parseUserDataDirFlag("/opt/google/chrome/chrome") === undefined, "B1: absent flag → undefined");
    check(parseUserDataDirFlag("chrome --user-data-dir=") === undefined, "B1: empty value → undefined");
  }

  // B2: an explicit --user-data-dir is decisive in both directions
  {
    const target = "/tmp/pi-e2e-abc";
    const match = rankBrowserCandidate({ exePath: "/opt/google/chrome/chrome", explicitUserDataDir: target }, target);
    const other = rankBrowserCandidate(
      { exePath: "/opt/google/chrome/chrome", explicitUserDataDir: "/tmp/somewhere-else" },
      target,
    );
    const noFlag = rankBrowserCandidate({ exePath: "/opt/google/chrome/chrome" }, target);
    check(match > noFlag, "B2: exact user-data-dir match outranks a flagless process");
    check(other < noFlag, "B2: a DIFFERENT explicit user-data-dir ranks below a flagless process");
    check(other === 0, "B2: a different explicit dir is disqualified outright");
  }

  // B3: browser family match decides between flagless processes
  {
    const braveDir = join(homedir(), ".config/BraveSoftware/Brave-Browser");
    const brave = rankBrowserCandidate({ exePath: "/usr/bin/brave-browser" }, braveDir);
    const chrome = rankBrowserCandidate({ exePath: "/opt/google/chrome/chrome" }, braveDir);
    check(brave > chrome, "B3: Brave wins for a Brave user-data-dir");

    const chromeDir = join(homedir(), ".config/google-chrome");
    check(
      rankBrowserCandidate({ exePath: "/opt/google/chrome/chrome" }, chromeDir) >
        rankBrowserCandidate({ exePath: "/usr/bin/brave-browser" }, chromeDir),
      "B3: Chrome wins for a Chrome user-data-dir",
    );

    const chromiumDir = join(homedir(), ".config/chromium");
    check(
      rankBrowserCandidate({ exePath: "/usr/bin/chromium" }, chromiumDir) >
        rankBrowserCandidate({ exePath: "/opt/google/chrome/chrome" }, chromiumDir),
      "B3: Chromium is not mistaken for Chrome",
    );
  }

  // B4: no preference expressed → every candidate is equally acceptable
  {
    check(
      rankBrowserCandidate({ exePath: "/usr/bin/brave-browser" }) ===
        rankBrowserCandidate({ exePath: "/opt/google/chrome/chrome" }),
      "B4: without a target dir, candidates rank equally",
    );
  }

  // B5: Windows path comparison ignores case and separator style
  if (process.platform === "win32") {
    check(
      rankBrowserCandidate(
        { exePath: "C:\\Program Files\\Google\\Chrome\\Application\\chrome.exe", explicitUserDataDir: "C:\\Users\\U\\Data" },
        "c:/users/u/data",
      ) === 4,
      "B5 win: case and separator differences still match",
    );
  }

  // B6: Linux's deleted-binary marker. An in-place `google-chrome` upgrade
  // unlinks the running binary, after which /proc/<pid>/exe reads
  // "…/chrome (deleted)" — a path spawn() rejects with ENOENT.
  {
    check(
      stripDeletedSuffix("/opt/google/chrome/chrome (deleted)") === "/opt/google/chrome/chrome",
      "B6: marker stripped from a replaced binary's path",
    );
    check(stripDeletedSuffix("/opt/google/chrome/chrome") === undefined, "B6: unmarked path left alone");
    check(stripDeletedSuffix(" (deleted)") === undefined, "B6: marker alone is not a path");
  }

  // B7: only a path that is actually on disk may be handed on as spawnable.
  {
    const root = mkdtempSync(join(tmpdir(), "pi-exe-"));
    try {
      const real = join(root, "chrome");
      writeFileSync(real, "#!/bin/sh\n");
      chmodSync(real, 0o755);

      check(await spawnableExePath(real) === real, "B7: an existing path is returned unchanged");
      check(
        await spawnableExePath(`${real} (deleted)`) === real,
        "B7: a replaced binary resolves to the live install path",
      );
      check(await spawnableExePath(join(root, "absent")) === undefined, "B7: a missing path yields undefined");
      check(await spawnableExePath("") === undefined, "B7: an empty path yields undefined");

      // The launch gate must never pass on a path it cannot spawn — that is
      // what produced a 15s "couldn't open a window" timeout instead of a
      // named error.
      check(
        await resolveBrowserExecutable({ running: true, exePath: `${real} (deleted)` }) === real,
        "B7: resolveBrowserExecutable repairs a replaced-binary path",
      );
      if (process.platform !== "win32") {
        check(
          await resolveBrowserExecutable({ running: true, exePath: join(root, "absent") }) === undefined,
          "B7: an unspawnable path is not passed on as usable",
        );
      }

      // A binary genuinely named "… (deleted)" must win over the stripped form.
      // Created last, so the checks above see only the ordinary case.
      const literal = join(root, "chrome (deleted)");
      writeFileSync(literal, "#!/bin/sh\n");
      chmodSync(literal, 0o755);
      check(
        await spawnableExePath(literal) === literal,
        "B7: a real file named '… (deleted)' is preferred over stripping",
      );
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
