import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  WINDOWS_USER_DATA_DIRS,
  isWSL,
  parseProcNetRoute,
  windowsLocalAppDataRoots,
  wslWindowsBrowserRunning,
  wslWindowsProfileDataDirs,
} from "../../src/profile/wsl";

describe("WSL detection", () => {
  test("a WSL kernel string carries microsoft", () => {
    assert.equal(isWSL("5.15.90.1-microsoft-standard-WSL2"), true);
    assert.equal(isWSL("4.4.0-19041-Microsoft"), true);
  });

  test("plain Linux and darwin kernels do not", () => {
    assert.equal(isWSL("6.8.0-45-generic"), false);
    assert.equal(isWSL("24.5.0"), false);
  });
});

describe("windowsLocalAppDataRoots", () => {
  const tree = (root: string, drive: string, user: string, withLocal: boolean): string => {
    const lad = join(root, drive, "Users", user, "AppData", "Local");
    if (withLocal) mkdirSync(lad, { recursive: true });
    else mkdirSync(join(root, drive, "Users", user), { recursive: true });
    return lad;
  };

  test("walks /mnt/<drive>/Users/<user>/AppData/Local, skipping non-profile dirs and mount holes", () => {
    const root = mkdtempSync(join(tmpdir(), "bh-wsl-"));
    try {
      const brave = tree(root, "c", "alice", true);
      tree(root, "c", "Public", true);
      tree(root, "d", "bob", true);
      tree(root, "e", "ghost", false); // user dir without AppData/Local
      mkdirSync(join(root, "z"), { recursive: true }); // drive without Users
      const roots = windowsLocalAppDataRoots(root);
      assert.ok(roots.includes(brave));
      assert.equal(roots.filter((r) => r.includes("Public")).length, 0);
      assert.equal(roots.filter((r) => r.includes("ghost")).length, 0);
      assert.equal(roots.length, 2); // alice on c:, bob on d:
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("a missing mount root yields nothing, not a throw", () => {
    assert.deepEqual([...windowsLocalAppDataRoots(join(tmpdir(), "bh-wsl-missing-xyz"))], []);
  });
});

describe("wslWindowsProfileDataDirs", () => {
  test("builds every Windows browser user-data dir under each AppData/Local root", () => {
    const root = mkdtempSync(join(tmpdir(), "bh-wsl-"));
    try {
      const lad = join(root, "c", "Users", "alice", "AppData", "Local");
      mkdirSync(lad, { recursive: true });
      const dirs = wslWindowsProfileDataDirs(root);
      assert.equal(dirs.length, WINDOWS_USER_DATA_DIRS.length);
      for (const rel of WINDOWS_USER_DATA_DIRS) {
        assert.ok(dirs.includes(join(lad, rel)), `expected ${rel}`);
      }
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("wslWindowsBrowserRunning", () => {
  test("a readable DevToolsActivePort under any Windows profile counts as a running browser", () => {
    const root = mkdtempSync(join(tmpdir(), "bh-wsl-"));
    try {
      const brave = join(root, "c", "Users", "alice", "AppData", "Local", "BraveSoftware/Brave-Browser/User Data");
      mkdirSync(brave, { recursive: true });
      assert.equal(wslWindowsBrowserRunning(root), false);
      writeFileSync(join(brave, "DevToolsActivePort"), "9222\n/devtools/browser/abc\n");
      assert.equal(wslWindowsBrowserRunning(root), true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test("no Windows profiles at all reads as not running", () => {
    const root = mkdtempSync(join(tmpdir(), "bh-wsl-"));
    try {
      assert.equal(wslWindowsBrowserRunning(root), false);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe("parseProcNetRoute", () => {
  test("extracts the default-route gateway as a dotted quad (little-endian hex)", () => {
    const raw = [
      "Iface\tDestination\tGateway\tFlags\tRefCnt\tUse\tMetric\tMask\tMTU\tWindow\tIRTT",
      "eth0\t00000000\t013015AC\t0003\t0\t0\t0\t00000000\t0\t0\t0",
      "eth0\t01304800\t00000000\t0001\t0\t0\t0\t00F0FFFF\t0\t0\t0",
    ].join("\n");
    assert.equal(parseProcNetRoute(raw), "172.21.48.1");
  });

  test("no default route yields undefined", () => {
    const raw = "Iface\tDestination\tGateway\neth0\t01481500\t00000000\n";
    assert.equal(parseProcNetRoute(raw), undefined);
  });

  test("malformed rows are skipped, not thrown", () => {
    assert.equal(parseProcNetRoute("garbage\n\nshort row"), undefined);
    assert.equal(parseProcNetRoute(""), undefined);
  });
});