// Which browsers are installed on this machine, for opening one that is closed. Detecting a RUNNING browser is browser-process.ts's job.

import { access, constants } from "node:fs/promises";
import { homedir } from "node:os";
import { posix, win32 } from "node:path";
import { WIN_INSTALL_SUFFIXES } from "./browser-process";
import { browserNameForUserDataDir } from "./paths";

export type InstalledBrowser = {
  // The same name browserNameForUserDataDir gives a profile directory, so a pin can be matched to its browser.
  readonly family: string;
  readonly exePath: string;
};

export type InstalledBrowsersDeps = {
  readonly platform?: NodeJS.Platform;
  readonly env?: NodeJS.ProcessEnv;
  readonly home?: string;
  readonly isExecutable?: (path: string) => Promise<boolean>;
};

const canExecute = async (path: string): Promise<boolean> => {
  try {
    await access(path, constants.X_OK);
    return true;
  } catch {
    return false;
  }
};

// Stable channels only: a beta or canary build is never opened on the user's behalf.
const LINUX_COMMANDS: ReadonlyArray<readonly [family: string, names: ReadonlyArray<string>]> = [
  ["Chrome", ["google-chrome", "google-chrome-stable"]],
  ["Chromium", ["chromium", "chromium-browser"]],
  ["Brave", ["brave-browser", "brave"]],
  ["Edge", ["microsoft-edge", "microsoft-edge-stable"]],
];

const MAC_APPS: ReadonlyArray<readonly [family: string, app: string]> = [
  ["Chrome", "Google Chrome"],
  ["Chromium", "Chromium"],
  ["Brave", "Brave Browser"],
  ["Edge", "Microsoft Edge"],
];

const candidatesFor = (platform: NodeJS.Platform, env: NodeJS.ProcessEnv, home: string): ReadonlyArray<InstalledBrowser> => {
  if (platform === "darwin") {
    const roots = ["/Applications", posix.join(home, "Applications")];
    return MAC_APPS.flatMap(([family, app]) =>
      roots.map((root) => ({ family, exePath: posix.join(root, `${app}.app`, "Contents", "MacOS", app) })));
  }
  if (platform === "win32") {
    const roots = [env["PROGRAMFILES"], env["PROGRAMFILES(X86)"], env["LOCALAPPDATA"]]
      .filter((r): r is string => typeof r === "string" && r.length > 0);
    return WIN_INSTALL_SUFFIXES
      .filter((suffix) => !suffix.includes("Beta") && !suffix.includes("SxS"))
      .flatMap((suffix) => roots.map((root) => ({ family: browserNameForUserDataDir(suffix), exePath: win32.join(root, suffix) })));
  }
  const dirs = (env["PATH"] ?? "").split(":").filter((dir) => dir.length > 0);
  return LINUX_COMMANDS.flatMap(([family, names]) =>
    names.flatMap((name) => dirs.map((dir) => ({ family, exePath: posix.join(dir, name) }))));
};

// One entry per browser family: the first location of it that exists.
export const installedBrowsers = async (deps: InstalledBrowsersDeps = {}): Promise<ReadonlyArray<InstalledBrowser>> => {
  const isExecutable = deps.isExecutable ?? canExecute;
  const found = new Map<string, InstalledBrowser>();
  for (const candidate of candidatesFor(deps.platform ?? process.platform, deps.env ?? process.env, deps.home ?? homedir())) {
    if (found.has(candidate.family)) continue;
    if (await isExecutable(candidate.exePath)) found.set(candidate.family, candidate);
  }
  return Array.from(found.values());
};

const PRERELEASE_DIR = /beta|unstable|canary|nightly|sxs|[-\s]dev\b/i;

// A pinned profile names its browser. Without one there is a choice only when a single browser is installed: guessing among several could open the wrong one.
export const chooseBrowserToLaunch = (
  installed: ReadonlyArray<InstalledBrowser>,
  pinnedUserDataDir?: string,
): InstalledBrowser | undefined => {
  if (pinnedUserDataDir !== undefined) {
    // Only stable builds are looked up, and each channel keeps its own profile store: opening stable Chrome for a Chrome Beta pin would land in a different one.
    if (PRERELEASE_DIR.test(pinnedUserDataDir)) return undefined;
    const family = browserNameForUserDataDir(pinnedUserDataDir);
    return installed.find((b) => b.family === family);
  }
  return installed.length === 1 ? installed[0] : undefined;
};
