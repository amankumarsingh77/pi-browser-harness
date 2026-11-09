import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { chooseBrowserToLaunch, installedBrowsers, type InstalledBrowser } from "../../src/profile/installed";

// A file system that holds exactly the given paths, so nothing installed on this machine is consulted.
const only = (...paths: ReadonlyArray<string>) => (path: string): Promise<boolean> => Promise.resolve(paths.includes(path));

describe("installedBrowsers", () => {
  test("linux: browsers are found by name on PATH, one entry per family", async () => {
    const found = await installedBrowsers({
      platform: "linux",
      env: { PATH: "/usr/local/bin:/usr/bin" },
      home: "/home/u",
      isExecutable: only("/usr/bin/google-chrome", "/usr/bin/google-chrome-stable", "/usr/local/bin/brave-browser"),
    });
    assert.deepEqual(found, [
      { family: "Chrome", exePath: "/usr/bin/google-chrome" },
      { family: "Brave", exePath: "/usr/local/bin/brave-browser" },
    ]);
  });

  test("linux: an empty or missing PATH finds nothing", async () => {
    assert.deepEqual(await installedBrowsers({ platform: "linux", env: {}, home: "/home/u", isExecutable: only("/usr/bin/google-chrome") }), []);
  });

  test("macOS: app bundles are found in /Applications and the user's own Applications folder", async () => {
    const found = await installedBrowsers({
      platform: "darwin",
      env: {},
      home: "/Users/u",
      isExecutable: only(
        "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
        "/Users/u/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
      ),
    });
    assert.deepEqual(found, [
      { family: "Chrome", exePath: "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome" },
      { family: "Edge", exePath: "/Users/u/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge" },
    ]);
  });

  test("windows: install locations under the Program Files roots are checked", async () => {
    const found = await installedBrowsers({
      platform: "win32",
      env: { PROGRAMFILES: "C:\\Program Files", "PROGRAMFILES(X86)": "C:\\Program Files (x86)" },
      home: "C:\\Users\\u",
      isExecutable: only("C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe"),
    });
    assert.deepEqual(found, [{ family: "Edge", exePath: "C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe" }]);
  });
});

describe("chooseBrowserToLaunch", () => {
  const chrome: InstalledBrowser = { family: "Chrome", exePath: "/usr/bin/google-chrome" };
  const brave: InstalledBrowser = { family: "Brave", exePath: "/usr/bin/brave-browser" };

  test("the only installed browser is chosen when nothing is pinned", () => {
    assert.deepEqual(chooseBrowserToLaunch([chrome]), chrome);
  });

  test("with several installed and nothing pinned there is no choice: guessing could open the wrong browser", () => {
    assert.equal(chooseBrowserToLaunch([chrome, brave]), undefined);
  });

  test("a pinned profile picks its own browser out of several", () => {
    assert.deepEqual(chooseBrowserToLaunch([chrome, brave], "/home/u/.config/BraveSoftware/Brave-Browser"), brave);
  });

  test("a pin for a browser that is not installed chooses nothing, even if another one is", () => {
    assert.equal(chooseBrowserToLaunch([chrome], "/home/u/.config/BraveSoftware/Brave-Browser"), undefined);
  });

  test("a pin in a beta, dev or canary build's directory chooses nothing: the stable build would open a different profile store", () => {
    for (const dir of [
      "/home/u/.config/google-chrome-beta",
      "/home/u/.config/google-chrome-unstable",
      "/Users/u/Library/Application Support/Google/Chrome Canary",
      "C:\\Users\\u\\AppData\\Local\\Google\\Chrome SxS\\User Data",
      "/home/u/.config/BraveSoftware/Brave-Browser-Nightly",
      "/home/u/.config/microsoft-edge-dev",
    ]) {
      assert.equal(chooseBrowserToLaunch([chrome, brave, { family: "Edge", exePath: "/usr/bin/microsoft-edge" }], dir), undefined, dir);
    }
  });

  test("nothing installed chooses nothing", () => {
    assert.equal(chooseBrowserToLaunch([]), undefined);
  });
});
