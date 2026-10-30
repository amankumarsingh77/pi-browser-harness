// WSL (Windows Subsystem for Linux) support.
//
// Under WSL the user's browser typically runs on the Windows side, not in the Linux
// environment. Two consequences for discovery:
//   1. browser-process detection (ps//proc) sees no browser even though one is running
//      — the Windows profile's DevToolsActivePort, reachable through /mnt, is the
//      reliable evidence instead.
//   2. The debug port is bound on Windows, so "127.0.0.1" means Windows loopback. In
//      WSL2 NAT mode that loopback is unreachable from here, while mirrored-networking
//      mode and a portproxy make it (or the first-hop gateway) work. See discovery.ts
//      for the host fallback and guidance.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { release as osRelease } from "node:os";

// WSL1 and WSL2 kernels both carry "microsoft" (e.g. "5.15.90.1-microsoft-standard-WSL2").
export const isWSL = (release: string = osRelease()): boolean =>
  release.toLowerCase().includes("microsoft");

// Mirror of the win32 branch of userDataDirCandidates, relative to a Windows profile's
// AppData\Local. Kept in one place so the two lists cannot drift.
export const WINDOWS_USER_DATA_DIRS: ReadonlyArray<string> = [
  "Google/Chrome/User Data",
  "Google/Chrome Beta/User Data",
  "Google/Chrome Dev/User Data",
  "Google/Chrome SxS/User Data",
  "Chromium/User Data",
  "BraveSoftware/Brave-Browser/User Data",
  "BraveSoftware/Brave-Browser-Beta/User Data",
  "Microsoft/Edge/User Data",
  "Microsoft/Edge Beta/User Data",
  "Microsoft/Edge Dev/User Data",
  "Microsoft/Edge SxS/User Data",
];

// Directory names under /mnt/<drive>/Users that are never real per-user profiles.
const NON_USER_DIRS: ReadonlyArray<string> = [
  "Public", "Default", "Default User", "All Users",
];

const readdirOrNull = (dir: string): string[] | undefined => {
  try {
    return readdirSync(dir);
  } catch {
    return undefined;
  }
};

// Windows per-user AppData\Local roots reachable through /mnt. Order is a directory-walk
// artifact, not a preference — discovery itself ranks candidates by DevToolsActivePort mtime.
export const windowsLocalAppDataRoots = (mountRoot = "/mnt"): ReadonlyArray<string> => {
  const roots: string[] = [];
  for (const drive of readdirOrNull(mountRoot) ?? []) {
    const usersDir = join(mountRoot, drive, "Users");
    for (const user of readdirOrNull(usersDir) ?? []) {
      if (NON_USER_DIRS.includes(user)) continue;
      const lad = join(usersDir, user, "AppData", "Local");
      // A directory listing proves this is a mounted filesystem entry, not a stale symlink;
      // an empty/non-directory path yields no candidates downstream anyway.
      if (readdirOrNull(lad) !== undefined) roots.push(lad);
    }
  }
  return roots;
};

export const wslWindowsProfileDataDirs = (mountRoot = "/mnt"): ReadonlyArray<string> => {
  const dirs: string[] = [];
  for (const lad of windowsLocalAppDataRoots(mountRoot)) {
    for (const rel of WINDOWS_USER_DATA_DIRS) dirs.push(join(lad, rel));
  }
  return dirs;
};

// True when any Windows profile reachable through /mnt currently advertises a DevTools
// port. A stale DevToolsActivePort (browser closed since) still reads as running here —
// connection failure surfaces the actionable error later, which is the same trade the
// Linux loop makes with a ps sighting of an exited process.
export const wslWindowsBrowserRunning = (mountRoot = "/mnt"): boolean => {
  for (const dir of wslWindowsProfileDataDirs(mountRoot)) {
    if (existsSync(join(dir, "DevToolsActivePort"))) return true;
  }
  return false;
};

type RouteRow = {
  readonly destination: string;
  readonly gateway: string;
};

// /proc/net/route rows carry little-endian hex addresses, e.g. gateway 172.21.48.1 reads 013015AC (uppercase hex).
const hexLeToIp = (hex: string): string | undefined => {
  if (!/^[0-9a-fA-F]{8}$/.test(hex)) return undefined;
  const bytes = [hex.slice(6, 8), hex.slice(4, 6), hex.slice(2, 4), hex.slice(0, 2)];
  return bytes.map((b) => parseInt(b, 16)).join(".");
};

export const parseProcNetRoute = (raw: string): string | undefined => {
  for (const line of raw.trim().split("\n")) {
    const cols = line.trim().split(/\s+/);
    if (cols.length < 3) continue;
    const row: RouteRow = { destination: cols[1] ?? "", gateway: cols[2] ?? "" };
    if (row.destination !== "00000000" || row.gateway === "00000000") continue;
    return hexLeToIp(row.gateway);
  }
  return undefined;
};

// The first-hop gateway is the Windows host's address on the WSL NAT subnet (the vEthernet WSL
// adapter, e.g. 172.21.48.1). In NAT mode it is the only address on the Windows side that WSL can
// dial at all: a one-time portproxy listening there forwards to the browser's loopback port, and a
// browser bound beyond loopback is reachable with no forwarding at all. Under mirrored networking
// this address is never needed — the shared loopback already works. Undefined when no default
// route exists (rare; WSL always has one in NAT mode).
export const wslWindowsHostAddress = (): string | undefined => {
  let raw: string;
  try {
    raw = readFileSync("/proc/net/route", "utf8");
  } catch {
    return undefined;
  }
  return parseProcNetRoute(raw);
};