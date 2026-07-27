/**
 * Identifying the browser process the harness is attached to.
 *
 * Two questions, deliberately kept apart:
 *
 *   1. Is a Chromium-family browser RUNNING? (`detectRunningBrowser().running`)
 *      Only live-process evidence may answer this — an installed-but-closed
 *      browser must read as "not running", which is why the registry lookup
 *      below is never consulted here.
 *
 *   2. Which binary do we invoke to open a window for a chosen profile?
 *      (`resolveBrowserExecutable()`) Chromium's ProcessSingleton hands a second
 *      launch's argv to the already-running browser instead of starting another
 *      one — Windows via WM_COPYDATA (process_singleton_win.cc), Linux and macOS
 *      via the socket in the user-data-dir (process_singleton_posix.cc, which is
 *      compiled on macOS too). Here an installed path is a fine fallback.
 *
 * Whether the running browser carries an explicit `--user-data-dir` matters:
 * ProcessSingleton keys on that directory, so passing a path that differs from
 * the running browser's by case or normalisation would start a SECOND browser
 * rather than delegating. The flag is forwarded only when the running process
 * already has one.
 *
 * Every probe is best-effort; when nothing can be determined, profile launching
 * degrades to a clear message rather than guessing.
 *
 * Windows note: `wmic` is deliberately unused — Microsoft removed it by default
 * in Windows 11 24H2 and entirely in 25H2. PowerShell CIM is the supported
 * replacement, with `tasklist` for liveness and the documented App Paths
 * registry key for install location.
 */

import { execFile } from "node:child_process";
import { access, readFile, readlink } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { browserNameForUserDataDir } from "./paths";

// execFile, not exec: arguments are passed as an array, with no shell involved.
const run = promisify(execFile);
const EXEC_TIMEOUT_MS = 5_000;

export type RunningBrowser = {
  /** True when a Chromium-family browser process is live. */
  readonly running: boolean;
  /** Absolute path to the running browser's binary, when determinable. */
  readonly exePath?: string;
  /** Value of an explicit --user-data-dir on the running process, if any. */
  readonly explicitUserDataDir?: string;
};

/** Chromium-family process names, lowercase, as they appear per platform. */
const LINUX_COMMS: ReadonlyArray<string> = [
  "chrome", "chromium", "chromium-browser", "msedge", "microsoft-edge",
  "google-chrome", "brave", "brave-browser",
];
const MAC_BROWSER_NAMES: ReadonlyArray<string> = [
  "google chrome", "chromium", "microsoft edge", "brave browser",
];
const WIN_IMAGE_NAMES: ReadonlyArray<string> = ["chrome.exe", "msedge.exe", "brave.exe"];

/**
 * Chromium tags every child process with `--type=<role>`; only the browser
 * process omits it or carries `--type=browser`. Matching the flag (rather than
 * words like "renderer" anywhere in the string) keeps a user whose install path
 * contains such a word from being filtered out.
 */
const hasChildProcessType = (commandLine: string): boolean => {
  const lower = commandLine.toLowerCase();
  return lower.includes("--type=") && !lower.includes("--type=browser");
};

/**
 * macOS names its child processes in the executable path itself ("Google Chrome
 * Helper (Renderer)", crashpad, updaters), so the process NAME must be filtered
 * too — the same exclusions the previous setup.ts check applied.
 */
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

/** One running browser process, as much as the platform will tell us. */
export type BrowserCandidate = {
  readonly exePath?: string;
  readonly explicitUserDataDir?: string;
};

/**
 * Linux marks a replaced binary in `/proc/<pid>/exe`: once the file behind a
 * running process is unlinked — which is exactly what a `google-chrome` package
 * upgrade does while the browser keeps running — the symlink reads
 * "/opt/google/chrome/chrome (deleted)". Spawning that string fails with
 * ENOENT, so the marker has to come off.
 *
 * It is stripped only as a fallback, and only when the stripped path exists: a
 * binary genuinely named "… (deleted)" must still win.
 */
const DELETED_SUFFIX = " (deleted)";

/** The path without Linux's deleted-binary marker, or undefined if unmarked. */
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

/**
 * A spawnable executable path for a raw readlink/argv value: the value itself
 * when it exists, else the same value with the deleted-binary marker removed.
 * Undefined when neither form is on disk — a path we cannot spawn must never be
 * handed on as if it were usable.
 */
export const spawnableExePath = async (raw: string): Promise<string | undefined> => {
  if (raw.length === 0) return undefined;
  if (await exists(raw)) return raw;
  const stripped = stripDeletedSuffix(raw);
  if (stripped && (await exists(stripped))) return stripped;
  return undefined;
};

/** Path comparison that tolerates separator and case differences per platform. */
const samePath = (a: string, b: string): boolean => {
  const norm = (p: string): string => {
    const unified = p.replace(/\\/g, "/").replace(/\/+$/, "");
    return process.platform === "linux" ? unified : unified.toLowerCase();
  };
  return norm(a) === norm(b);
};

/**
 * Rank a candidate against the user-data-dir the harness is actually connected
 * to. Several Chromium browsers can run at once (Chrome plus Brave, or a second
 * instance on a custom dir), and launching a profile window into the wrong one
 * would open a window the harness cannot see — while disturbing a browser the
 * user never pointed us at.
 */
export const rankBrowserCandidate = (candidate: BrowserCandidate, preferUserDataDir?: string): number => {
  if (!preferUserDataDir) return 1;
  if (candidate.explicitUserDataDir) {
    // An explicit dir is decisive in both directions: exact match wins, and a
    // different one means this is definitively another browser instance.
    return samePath(candidate.explicitUserDataDir, preferUserDataDir) ? 4 : 0;
  }
  // No flag: the process uses its default dir. Prefer the one whose executable
  // belongs to the same browser family as the target directory.
  const family = browserNameForUserDataDir(preferUserDataDir).toLowerCase();
  const exe = (candidate.exePath ?? "").toLowerCase();
  if (!exe) return 1;
  if (family === "brave" && exe.includes("brave")) return 3;
  if (family === "edge" && (exe.includes("edge") || exe.includes("msedge"))) return 3;
  if (family === "chromium" && exe.includes("chromium")) return 3;
  if (family === "chrome" && exe.includes("chrome") && !exe.includes("chromium")) return 3;
  return 1;
};

/** Extract `--user-data-dir=<path>` from a command line, quoted or bare. */
export const parseUserDataDirFlag = (commandLine: string): string | undefined => {
  const match = /--user-data-dir=(?:"([^"]*)"|'([^']*)'|(\S+))/.exec(commandLine);
  if (!match) return undefined;
  const value = match[1] ?? match[2] ?? match[3];
  return value && value.length > 0 ? value : undefined;
};

// ── Linux ──────────────────────────────────────────────────────────────────

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
      // /proc/<pid>/cmdline is NUL-separated argv.
      cmdline = (await readFile(`/proc/${pid}/cmdline`, "utf8")).replace(/\0/g, " ").trim();
    } catch {
      continue;
    }
    if (!cmdline || hasChildProcessType(cmdline)) continue;
    let link: string | undefined;
    try {
      link = await readlink(`/proc/${pid}/exe`);
    } catch {
      // /proc/<pid>/exe is unreadable for processes we don't own.
    }
    // argv[0] backs up the symlink in both directions: unreadable for a process
    // we don't own, and pointing at an unlinked binary after an in-place
    // upgrade. Chrome's browser process rewrites its argv to the bare
    // executable path, so on Linux argv[0] is the live install location.
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

// ── macOS ──────────────────────────────────────────────────────────────────

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
      // args are optional — only the --user-data-dir probe needs them
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

// ── Windows ────────────────────────────────────────────────────────────────

const POWERSHELL_QUERY = [
  "$ErrorActionPreference='SilentlyContinue';",
  "Get-CimInstance Win32_Process",
  "-Filter \"Name='chrome.exe' or Name='msedge.exe' or Name='brave.exe'\"",
  "| Select-Object ExecutablePath,CommandLine",
  "| ConvertTo-Json -Compress",
].join(" ");

type WinProcess = { ExecutablePath?: string | null; CommandLine?: string | null };

const collectWin32 = async (): Promise<ReadonlyArray<BrowserCandidate>> => {
  try {
    const { stdout } = await run(
      "powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", POWERSHELL_QUERY],
      { timeout: EXEC_TIMEOUT_MS, windowsHide: true },
    );
    const trimmed = stdout.trim();
    if (trimmed) {
      const parsed: unknown = JSON.parse(trimmed);
      // ConvertTo-Json emits an object for a single row, an array for many.
      const rows: WinProcess[] = Array.isArray(parsed) ? (parsed as WinProcess[]) : [parsed as WinProcess];
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
  } catch {
    // PowerShell missing or blocked by policy — fall through to tasklist.
  }

  // Liveness-only fallback: tasklist still ships on every supported Windows.
  // It reveals no path, so the candidate is a bare "something is running".
  try {
    const { stdout } = await run("tasklist.exe", [], { timeout: EXEC_TIMEOUT_MS, windowsHide: true });
    const lower = stdout.toLowerCase();
    if (WIN_IMAGE_NAMES.some((n) => lower.includes(n))) return [{}];
  } catch {
    // best-effort
  }
  return [];
};

/** Installed-browser locations to try when the live process reveals no path. */
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

/** Query the Shell's App Paths registration for a browser's install location. */
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
        // key absent for this browser/hive — try the next
      }
    }
  }
  return undefined;
};

// ── Public API ─────────────────────────────────────────────────────────────

/**
 * Live-process facts about the running Chromium-family browser. `running` is
 * derived only from process evidence, never from an install location.
 *
 * `preferUserDataDir` should be the dir the harness is connected to; with more
 * than one browser running it decides which process is described.
 */
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

/** True when a Chromium-family browser process is running. */
export const isBrowserRunning = async (): Promise<boolean> => (await detectRunningBrowser()).running;

/**
 * The binary to invoke when opening a window for a chosen profile: the running
 * browser's own executable when known, otherwise a documented install location.
 * Undefined when nothing usable is found.
 */
export const resolveBrowserExecutable = async (running?: RunningBrowser): Promise<string | undefined> => {
  const detected = running ?? (await detectRunningBrowser());
  // Re-check spawnability here too: this function is the single gate every
  // launch passes through, and a caller may hand us a RunningBrowser collected
  // before the binary was replaced on disk.
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
      // not installed here
    }
  }
  return undefined;
};
