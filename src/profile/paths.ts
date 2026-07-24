/**
 * Filesystem locations for browser profile discovery and pin persistence.
 *
 * Two independent path families live here:
 *
 *   1. Chromium user-data-dir candidates, per platform and channel. A
 *      user-data-dir holds `Local State` (the profile registry) and
 *      `DevToolsActivePort`; individual profiles are subdirectories of it
 *      (`Default`, `Profile 1`, …).
 *      Reference: https://chromium.googlesource.com/chromium/src/+/HEAD/docs/user_data_dir.md
 *
 *   2. pi's agent config dir, where the profile pin is stored.
 *
 * On the agent dir: pi exports `getAgentDir()` from
 * `@mariozechner/pi-coding-agent`, but importing it would be a RUNTIME import
 * of the host package. Extensions installed via `pi install npm:...` do not
 * get pi resolvable from their own node_modules (verified: the installed
 * tree's `@mariozechner/` directory is empty), which is why every other import
 * in this codebase is `import type` and erased at build time. So the three
 * lines of `getAgentDir()` are replicated here instead — env var first, then
 * `~/.pi/agent` (pi's dist/config.js: `PI_CODING_AGENT_DIR`, CONFIG_DIR_NAME
 * `.pi`).
 */

import { homedir } from "node:os";
import { join } from "node:path";

// ── pi agent config dir ────────────────────────────────────────────────────

/** pi's env override for the agent dir (APP_NAME.toUpperCase() + "_CODING_AGENT_DIR"). */
const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

/**
 * Expand a leading `~` exactly as pi's expandTildePath does — `~` and `~/…`
 * only, never `~\…`, on every platform. This deliberately mirrors pi rather
 * than improving on it: the pin has to land in the directory pi itself resolves
 * from the same variable, so being more lenient here would put the file
 * somewhere pi does not look.
 */
const expandTildePiCompatible = (path: string): string => {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return homedir() + path.slice(1);
  return path;
};

/**
 * Tilde expansion for values this package interprets on its own. Windows users
 * write `~\dir` as naturally as `~/dir`, and no compatibility constraint
 * applies, so both are accepted.
 */
const expandTildeLenient = (path: string): string => {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
};

/** pi's agent config directory — `$PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
export const agentDir = (): string => {
  const fromEnv = process.env[ENV_AGENT_DIR];
  if (fromEnv) return expandTildePiCompatible(fromEnv);
  return join(homedir(), ".pi", "agent");
};

/** Where the selected-profile pin is persisted. */
export const pinFilePath = (): string => join(agentDir(), "browser-harness.json");

// ── Chromium user-data-dir candidates ──────────────────────────────────────

/**
 * Windows resolves its per-user data root from %LOCALAPPDATA%, which can be
 * redirected on roaming / managed accounts. Fall back to the conventional
 * layout only when the variable is absent.
 */
const localAppData = (): string => process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");

/**
 * Every known default user-data-dir for Chromium-family browsers on the
 * current platform. Order is stable but carries no priority — callers probe
 * all of them.
 *
 * Includes paths the harness previously missed: snap Chromium (the default
 * Chromium on Ubuntu) and the Linux-only `$CHROME_USER_DATA_DIR` override
 * documented in user_data_dir.md.
 */
export const userDataDirCandidates = (): ReadonlyArray<string> => {
  const home = homedir();
  const dirs: string[] = [];

  // A user-set override wins a spot at the front regardless of platform.
  const envOverride = process.env["CHROME_USER_DATA_DIR"];
  if (envOverride) dirs.push(expandTildeLenient(envOverride));

  if (process.platform === "darwin") {
    const support = join(home, "Library", "Application Support");
    dirs.push(
      join(support, "Google/Chrome"),
      join(support, "Google/Chrome Beta"),
      join(support, "Google/Chrome Dev"),
      join(support, "Google/Chrome Canary"),
      join(support, "Chromium"),
      join(support, "BraveSoftware/Brave-Browser"),
      join(support, "BraveSoftware/Brave-Browser-Beta"),
      join(support, "BraveSoftware/Brave-Browser-Nightly"),
      join(support, "BraveSoftware/Brave-Browser-Dev"),
      join(support, "Microsoft Edge"),
      join(support, "Microsoft Edge Beta"),
      join(support, "Microsoft Edge Dev"),
      join(support, "Microsoft Edge Canary"),
    );
  } else if (process.platform === "win32") {
    const lad = localAppData();
    dirs.push(
      join(lad, "Google/Chrome/User Data"),
      join(lad, "Google/Chrome Beta/User Data"),
      join(lad, "Google/Chrome Dev/User Data"),
      join(lad, "Google/Chrome SxS/User Data"),
      join(lad, "Chromium/User Data"),
      join(lad, "BraveSoftware/Brave-Browser/User Data"),
      join(lad, "BraveSoftware/Brave-Browser-Beta/User Data"),
      join(lad, "Microsoft/Edge/User Data"),
      join(lad, "Microsoft/Edge Beta/User Data"),
      join(lad, "Microsoft/Edge Dev/User Data"),
      join(lad, "Microsoft/Edge SxS/User Data"),
    );
  } else {
    dirs.push(
      join(home, ".config/google-chrome"),
      join(home, ".config/google-chrome-beta"),
      join(home, ".config/google-chrome-unstable"),
      join(home, ".config/chromium"),
      join(home, ".config/chromium-browser"),
      join(home, ".config/BraveSoftware/Brave-Browser"),
      join(home, ".config/BraveSoftware/Brave-Browser-Beta"),
      join(home, ".config/BraveSoftware/Brave-Browser-Nightly"),
      join(home, ".config/microsoft-edge"),
      join(home, ".config/microsoft-edge-beta"),
      join(home, ".config/microsoft-edge-dev"),
      // snap (Ubuntu's default Chromium) — confined to ~/snap/<pkg>/common
      join(home, "snap/chromium/common/chromium"),
      // flatpak
      join(home, ".var/app/org.chromium.Chromium/config/chromium"),
      join(home, ".var/app/com.google.Chrome/config/google-chrome"),
      join(home, ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser"),
      join(home, ".var/app/com.microsoft.Edge/config/microsoft-edge"),
    );
  }

  // De-duplicate while preserving order — an env override may repeat a default.
  return Array.from(new Set(dirs));
};

/**
 * Human-readable browser name for a user-data-dir, used to disambiguate the
 * picker when more than one browser is installed. Falls back to the directory
 * name, which is already descriptive for every path we generate.
 */
export const browserNameForUserDataDir = (userDataDir: string): string => {
  const p = userDataDir.replace(/\\/g, "/");
  const has = (needle: string): boolean => p.toLowerCase().includes(needle);
  if (has("brave")) return "Brave";
  if (has("edge")) return "Edge";
  if (has("chromium")) return "Chromium";
  if (has("chrome")) return "Chrome";
  const last = p.split("/").filter(Boolean).pop();
  return last ?? userDataDir;
};
