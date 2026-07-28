// `running` is derived only from live-process evidence: an installed-but-closed browser must read as "not running".
// `wmic` is deliberately unused — Microsoft removed it by default in Windows 11 24H2 and entirely in 25H2, so PowerShell CIM plus tasklist replace it.

import { execFile } from "node:child_process";
import { access, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { parseJson } from "../schemas/parse";
import { browserNameForUserDataDir } from "./paths";

const run = promisify(execFile);
const EXEC_TIMEOUT_MS = 5_000;

export type RunningBrowser = {
  readonly running: boolean;
  readonly exePath?: string;
  readonly explicitUserDataDir?: string;
};

const LINUX_COMMS: ReadonlyArray<string> = [
  "chrome", "chromium", "chromium-browser", "msedge", "microsoft-edge",
  "google-chrome", "brave", "brave-browser",
];
const MAC_BROWSER_NAMES: ReadonlyArray<string> = [
  "google chrome", "chromium", "microsoft edge", "brave browser",
];
const WIN_IMAGE_NAMES: ReadonlyArray<string> = ["chrome.exe", "msedge.exe", "brave.exe"];

// Match the `--type=` flag, not words like "renderer" anywhere in the string, or an install path containing one is filtered out.
const hasChildProcessType = (commandLine: string): boolean => {
  const lower = commandLine.toLowerCase();
  return lower.includes("--type=") && !lower.includes("--type=browser");
};

// macOS names its child processes in the executable path itself, so the process NAME must be filtered too.
const isMacChildProcessName = (comm: string): boolean => {
  const lower = comm.toLowerCase();
  return (
    lower.includes("helper") ||
    lower.includes("renderer") ||
    lower.includes("crashpad") ||
    lower.includes(" gpu") ||
    lower.includes("updater")
  );
};

export type BrowserCandidate = {
  readonly exePath?: string;
  readonly explicitUserDataDir?: string;
};

// A package upgrade under a running browser makes `/proc/<pid>/exe` read "… (deleted)", which fails to spawn with ENOENT unless the marker comes off.
const DELETED_SUFFIX = " (deleted)";

export const stripDeletedSuffix = (path: string): string | undefined =>
  path.endsWith(DELETED_SUFFIX) && path.length > DELETED_SUFFIX.length
    ? path.slice(0, -DELETED_SUFFIX.length)
    : undefined;

const exists = async (path: string): Promise<boolean> => {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
};

export const spawnableExePath = async (raw: string): Promise<string | undefined> => {
  if (raw.length === 0) return undefined;
  if (await exists(raw)) return raw;
  const stripped = stripDeletedSuffix(raw);
  if (stripped && (await exists(stripped))) return stripped;
  return undefined;
};

const samePath = (a: string, b: string): boolean => {
  const norm = (p: string): string => {
    const unified = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "linux" ? unified : unified.toLowerCase();
  };
  return norm(a) === norm(b);
};

export const rankBrowserCandidate = (candidate: BrowserCandidate, preferUserDataDir?: string): number => {
  if (!preferUserDataDir) return 1;
  if (candidate.explicitUserDataDir) {
    return samePath(candidate.explicitUserDataDir, preferUserDataDir) ? 4 : 0;
  }
  const family = browserNameForUserDataDir(preferUserDataDir).toLowerCase();
  const exe = (candidate.exePath ?? "").toLowerCase();
  if (!exe) return 1;
  if (family === "brave" && exe.includes("brave")) return 3;
  if (family === "edge" && (exe.includes("edge") || exe.includes("msedge"))) return 3;
  if (family === "chromium" && exe.includes("chromium")) return 3;
  if (family === "chrome" && exe.includes("chrome") && !exe.includes("chromium")) return 3;
  return 1;
};

export const parseUserDataDirFlag = (commandLine: string): string | undefined => {
  const match = /--user-data-dir=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(commandLine);
  if (!match) return undefined;
  const value = match[1] ?? match[2] ?? match[3];
  return value && value.length > 0 ? value : undefined;
};


const collectLinux = async (): Promise<ReadonlyArray<BrowserCandidate>> => {
  let pids: string[];
  try {
    const { stdout } = await run("ps", ["-A", "-o", "pid=,comm="], { timeout: EXEC_TIMEOUT_MS });
    pids = stdout
      .split("\n")
      .map((line) => line.trim())
      .flatMap((line) => {
        const [pid, comm] = line.split(/\s+/, 2);
        if (!pid || !comm) return [];
        return LINUX_COMMS.includes(comm.toLowerCase()) ? [pid] : [];
      });
  } catch {
    return [];
  }

  const candidates: BrowserCandidate[] = [];
  for (const pid of pids) {
    let cmdline: string;
    try {
      cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim();
    } catch {
      continue;
    }
    if (!cmdline || hasChildProcessType(cmdline)) continue;
    let link: string | undefined;
    try {
      link = await readlink(`/proc/${pid}/exe`);
    } catch {
    }
    // Chrome rewrites its argv to the bare executable path, so argv[0] is the live install location when /proc/<pid>/exe is unreadable or stale.
    const exePath =
      (link ? await spawnableExePath(link) : undefined) ??
      (await spawnableExePath(cmdline.split(" ")[0] ?? ""));
    const explicit = parseUserDataDirFlag(cmdline);
    candidates.push({
      ...(exePath ? { exePath } : {}),
      ...(explicit ? { explicitUserDataDir: explicit } : {}),
    });
  }
  return candidates;
};


const collectDarwin = async (): Promise<ReadonlyArray<BrowserCandidate>> => {
  let lines: string[];
  try {
    // BSD ps prints the full executable path for `comm`, unlike Linux.
    const { stdout } = await run("ps", ["-A", "-ww", "-o", "pid=,comm="], { timeout: EXEC_TIMEOUT_MS });
    lines = stdout.split("\n").map((l) => l.trim()).filter(Boolean);
  } catch {
    return [];
  }

  const candidates: BrowserCandidate[] = [];
  for (const line of lines) {
    const spaceAt = line.indexOf(" ");
    if (spaceAt < 0) continue;
    const pid = line.slice(0, spaceAt);
    const comm = line.slice(spaceAt + 1).trim();
    const lower = comm.toLowerCase();
    if (!MAC_BROWSER_NAMES.some((name) => lower.includes(name))) continue;
    if (isMacChildProcessName(comm)) continue;

    let args = "";
    try {
      const { stdout } = await run("ps", ["-ww", "-o", "args=", "-p", pid], { timeout: EXEC_TIMEOUT_MS });
      args = stdout.trim();
    } catch {
    }
    if (args && hasChildProcessType(args)) continue;
    const explicit = args ? parseUserDataDirFlag(args) : undefined;
    candidates.push({
      exePath: comm,
      ...(explicit ? { explicitUserDataDir: explicit } : {}),
    });
  }
  return candidates;
};


const POWERSHELL_QUERY = [
  "$ErrorActionPreference='SilentlyContinue';",
  "Get-CimInstance Win32_Process",
  "-Filter \"Name='chrome.exe' or Name='msedge.exe' or Name='brave.exe'\"",
  "| Select-Object ExecutablePath,CommandLine",
  "| ConvertTo-Json -Compress",
].join(" ");

const WinProcessSchema = Type.Object(
  {
    ExecutablePath: Type.Optional(Type.Union([Type.String(), Type.Null()])),
    CommandLine: Type.Optional(Type.Union([Type.String(), Type.Null()])),
  },
  { additionalProperties: true },
);

const WinProcessesSchema = Type.Union([WinProcessSchema, Type.Array(WinProcessSchema)]);

const winProcessesValidator = Compile(WinProcessesSchema);

const collectWin32 = async (): Promise<ReadonlyArray<BrowserCandidate>> => {
  try {
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_QUERY],
      { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
    );
    const trimmed = stdout.trim();
    if (trimmed) {
      const parsed = parseJson(trimmed, winProcessesValidator);
      if (parsed.success) {
        const rows = Array.isArray(parsed.data) ? parsed.data : [parsed.data];
        const candidates = rows
          .filter((row) => !hasChildProcessType(row.CommandLine ?? ""))
          .map((row): BrowserCandidate => {
            const explicit = parseUserDataDirFlag(row.CommandLine ?? "");
            return {
              ...(row.ExecutablePath ? { exePath: row.ExecutablePath } : {}),
              ...(explicit ? { explicitUserDataDir: explicit } : {}),
            };
          });
        if (candidates.length > 0) return candidates;
      }
    }
  } catch {
  }

  try {
    const { stdout } = await run("tasklist.exe", [], { timeout: EXEC_TIMEOUT_MS, windowsHide: true });
    const lower = stdout.toLowerCase();
    if (WIN_IMAGE_NAMES.some((n) => lower.includes(n))) return [{}];
  } catch {
  }
  return [];
};

const winInstallCandidates = (): ReadonlyArray<string> => {
  const roots = [
    process.env["PROGRAMFILES"],
    process.env["PROGRAMFILES(X86)"],
    process.env["LOCALAPPDATA"],
  ].filter((r): r is string => typeof r === "string" && r.length > 0);
  const suffixes = [
    "Google\\Chrome\\Application\\chrome.exe",
    "Google\\Chrome Beta\\Application\\chrome.exe",
    "Google\\Chrome SxS\\Application\\chrome.exe",
    "Chromium\\Application\\chrome.exe",
    "BraveSoftware\\Brave-Browser\\Application\\brave.exe",
    "Microsoft\\Edge\\Application\\msedge.exe",
  ];
  return roots.flatMap((root) => suffixes.map((suffix) => join(root, suffix)));
};

const winRegistryExecutable = async (): Promise<string | undefined> => {
  for (const image of WIN_IMAGE_NAMES) {
    for (const hive of ["HKLM", "HKCU"]) {
      try {
        const { stdout } = await run(
          "reg.exe",
          ["query", `${hive}\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\App Paths\\${image}`, "/ve"],
          { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
        );
        const match = /REG_[A-Z_]+\s+(.+)$/m.exec(stdout.trim());
        const path = match?.[1]?.trim();
        if (path) return path;
      } catch {
      }
    }
  }
  return undefined;
};


export const detectRunningBrowser = async (preferUserDataDir?: string): Promise<RunningBrowser> => {
  const candidates =
    process.platform === "darwin"
      ? await collectDarwin()
      : process.platform === "win32"
        ? await collectWin32()
        : await collectLinux();
  if (candidates.length === 0) return { running: false };

  const [first, ...rest] = candidates;
  if (!first) return { running: false };
  let best = first;
  let bestRank = rankBrowserCandidate(best, preferUserDataDir);
  for (const candidate of rest) {
    const rank = rankBrowserCandidate(candidate, preferUserDataDir);
    if (rank > bestRank) {
      best = candidate;
      bestRank = rank;
    }
  }

  return {
    running: true,
    ...(best.exePath ? { exePath: best.exePath } : {}),
    ...(best.explicitUserDataDir ? { explicitUserDataDir: best.explicitUserDataDir } : {}),
  };
};

export const isBrowserRunning = async (): Promise<boolean> => (await detectRunningBrowser()).running;

export const resolveBrowserExecutable = async (running?: RunningBrowser): Promise<string | undefined> => {
  const detected = running ?? (await detectRunningBrowser());
  const usable = detected.exePath ? await spawnableExePath(detected.exePath) : undefined;
  if (usable) return usable;
  if (process.platform !== "win32") return undefined;

  const fromRegistry = await winRegistryExecutable();
  if (fromRegistry) return fromRegistry;
  for (const candidate of winInstallCandidates()) {
    try {
      await access(candidate);
      return candidate;
    } catch {
    }
  }
  return undefined;
};
