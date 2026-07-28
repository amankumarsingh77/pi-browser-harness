// pi's `getAgentDir()` is replicated rather than imported: a runtime import of the host package does not resolve for extensions installed via `pi install npm:...`.

import { homedir } from "node:os";
import { join } from "node:path";


const ENV_AGENT_DIR = "PI_CODING_AGENT_DIR";

// Deliberately mirrors pi's expandTildePath (never `~\…`) rather than improving on it, or the pin lands somewhere pi does not look.
const expandTildePiCompatible = (path: string): string => {
  if (path === "~") return homedir();
  if (path.startsWith("~/")) return homedir() + path.slice(1);
  return path;
};

const expandTildeLenient = (path: string): string => {
  if (path === "~") return homedir();
  if (path.startsWith("~/") || path.startsWith("~\\")) return join(homedir(), path.slice(2));
  return path;
};

export const agentDir = (): string => {
  const fromEnv = process.env[ENV_AGENT_DIR];
  if (fromEnv) return expandTildePiCompatible(fromEnv);
  return join(homedir(), ".pi", "agent");
};

export const pinFilePath = (): string => join(agentDir(), "browser-harness.json");


const localAppData = (): string => process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");

export const userDataDirCandidates = (): ReadonlyArray<string> => {
  const home = homedir();
  const dirs: string[] = [];

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
      join(home, "snap/chromium/common/chromium"),
      join(home, ".var/app/org.chromium.Chromium/config/chromium"),
      join(home, ".var/app/com.google.Chrome/config/google-chrome"),
      join(home, ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser"),
      join(home, ".var/app/com.microsoft.Edge/config/microsoft-edge"),
    );
  }

  return Array.from(new Set(dirs));
};

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
