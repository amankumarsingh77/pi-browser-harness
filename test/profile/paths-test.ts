/**
 * Unit tests for path resolution — runs on Linux, macOS, and Windows in CI.
 *
 * Only the branch for the host platform can be exercised, so each assertion is
 * guarded by process.platform; the CI matrix is what gives all three coverage.
 *
 * Run: npx tsx test/profile/paths-test.ts
 */
import { homedir } from "node:os";
import { join } from "node:path";

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

/** Re-import with a fresh module identity so env changes are picked up. */
const freshImport = async (): Promise<typeof import("../../src/profile/paths")> =>
  import(`../../src/profile/paths?cache=${Math.random()}`);

const withEnv = async (key: string, value: string | undefined, fn: () => Promise<void>): Promise<void> => {
  const saved = process.env[key];
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
  try {
    await fn();
  } finally {
    if (saved === undefined) delete process.env[key];
    else process.env[key] = saved;
  }
};

async function main(): Promise<void> {
  // A1: agent dir default and override
  await withEnv("PI_CODING_AGENT_DIR", undefined, async () => {
    const { agentDir, pinFilePath } = await freshImport();
    check(agentDir() === join(homedir(), ".pi", "agent"), "A1: default agent dir is ~/.pi/agent");
    check(pinFilePath() === join(homedir(), ".pi", "agent", "browser-harness.json"), "A1: pin file sits in it");
  });
  await withEnv("PI_CODING_AGENT_DIR", join("~", "custom-agent"), async () => {
    check((await freshImport()).agentDir() === join(homedir(), "custom-agent"), "A1: tilde in the override expands");
  });

  // A2: platform candidate list
  await withEnv("CHROME_USER_DATA_DIR", undefined, async () => {
    const dirs = (await freshImport()).userDataDirCandidates();
    check(dirs.length > 0, "A2: candidates are non-empty on this platform");
    check(new Set(dirs).size === dirs.length, "A2: candidate list is de-duplicated");

    if (process.platform === "linux") {
      check(dirs.includes(join(homedir(), ".config/google-chrome")), "A2 linux: Chrome stable dir present");
      check(dirs.includes(join(homedir(), "snap/chromium/common/chromium")), "A2 linux: snap Chromium dir present");
      check(dirs.includes(join(homedir(), ".config/BraveSoftware/Brave-Browser")), "A2 linux: Brave dir present");
    } else if (process.platform === "darwin") {
      const support = join(homedir(), "Library", "Application Support");
      check(dirs.includes(join(support, "Google/Chrome")), "A2 macos: Chrome dir present");
      check(dirs.includes(join(support, "BraveSoftware/Brave-Browser")), "A2 macos: Brave dir present");
      check(dirs.includes(join(support, "Microsoft Edge")), "A2 macos: Edge dir present");
    } else if (process.platform === "win32") {
      const lad = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
      check(dirs.includes(join(lad, "Google/Chrome/User Data")), "A2 win: Chrome dir derives from %LOCALAPPDATA%");
      check(dirs.includes(join(lad, "Microsoft/Edge/User Data")), "A2 win: Edge dir present");
    }
  });

  // A3: %LOCALAPPDATA% redirection is honoured (Windows-only behaviour)
  if (process.platform === "win32") {
    await withEnv("LOCALAPPDATA", "D:\\Redirected\\Local", async () => {
      const dirs = (await freshImport()).userDataDirCandidates();
      check(
        dirs.some((d) => d.startsWith("D:\\Redirected\\Local") || d.startsWith("D:/Redirected/Local")),
        "A3 win: redirected LOCALAPPDATA is used",
      );
    });
  }

  // A4: $CHROME_USER_DATA_DIR override leads the list
  await withEnv("CHROME_USER_DATA_DIR", join("~", "my-chrome-data"), async () => {
    const dirs = (await freshImport()).userDataDirCandidates();
    check(dirs[0] === join(homedir(), "my-chrome-data"), "A4: env override is first and tilde-expanded");
  });

  // A5: browser naming
  {
    const { browserNameForUserDataDir } = await freshImport();
    check(browserNameForUserDataDir("/home/u/.config/google-chrome") === "Chrome", "A5: Chrome recognised");
    check(
      browserNameForUserDataDir("/home/u/.config/BraveSoftware/Brave-Browser") === "Brave",
      "A5: Brave recognised",
    );
    check(
      browserNameForUserDataDir("C:\\Users\\u\\AppData\\Local\\Microsoft\\Edge\\User Data") === "Edge",
      "A5: Edge recognised through Windows separators",
    );
    check(browserNameForUserDataDir("/home/u/.config/chromium") === "Chromium", "A5: Chromium beats Chrome");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("profile paths test failed:", e);
  process.exit(1);
});
