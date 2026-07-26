/**
 * Unit tests for path resolution — runs on Linux, macOS, and Windows in CI.
 *
 * Only the branch for the host platform can be exercised, so each assertion is
 * guarded by process.platform; the CI matrix is what gives all three coverage.
 *
 * Run: npm test
 */
import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";

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

describe("path resolution", () => {
  // A1: agent dir default and override
  test("A1: default agent dir is ~/.pi/agent", async () => {
    await withEnv("PI_CODING_AGENT_DIR", undefined, async () => {
      const { agentDir } = await freshImport();
      assert.equal(agentDir(), join(homedir(), ".pi", "agent"));
    });
  });

  test("A1: pin file sits in it", async () => {
    await withEnv("PI_CODING_AGENT_DIR", undefined, async () => {
      const { pinFilePath } = await freshImport();
      assert.equal(pinFilePath(), join(homedir(), ".pi", "agent", "browser-harness.json"));
    });
  });

  // pi's own expandTildePath only understands "~/" — never "~\" — so the agent
  // dir must resolve identically or the pin lands where pi does not look.
  test("A1: '~/' in the agent-dir override expands like pi", async () => {
    await withEnv("PI_CODING_AGENT_DIR", "~/custom-agent", async () => {
      assert.equal((await freshImport()).agentDir(), `${homedir()}/custom-agent`);
    });
  });

  test("A1 win: '~\\' is left alone, matching pi's own resolution", { skip: process.platform !== "win32" }, async () => {
    await withEnv("PI_CODING_AGENT_DIR", "~\\custom-agent", async () => {
      assert.equal((await freshImport()).agentDir(), "~\\custom-agent");
    });
  });

  // A2: platform candidate list
  test("A2: candidates are non-empty on this platform", async () => {
    await withEnv("CHROME_USER_DATA_DIR", undefined, async () => {
      const dirs = (await freshImport()).userDataDirCandidates();
      assert.ok(dirs.length > 0);
    });
  });

  test("A2: candidate list is de-duplicated", async () => {
    await withEnv("CHROME_USER_DATA_DIR", undefined, async () => {
      const dirs = (await freshImport()).userDataDirCandidates();
      assert.equal(new Set(dirs).size, dirs.length);
    });
  });

  test("A2 linux: Chrome stable dir present", { skip: process.platform !== "linux" }, async () => {
    await withEnv("CHROME_USER_DATA_DIR", undefined, async () => {
      const dirs = (await freshImport()).userDataDirCandidates();
      assert.ok(dirs.includes(join(homedir(), ".config/google-chrome")));
    });
  });

  test("A2 linux: snap Chromium dir present", { skip: process.platform !== "linux" }, async () => {
    await withEnv("CHROME_USER_DATA_DIR", undefined, async () => {
      const dirs = (await freshImport()).userDataDirCandidates();
      assert.ok(dirs.includes(join(homedir(), "snap/chromium/common/chromium")));
    });
  });

  test("A2 linux: Brave dir present", { skip: process.platform !== "linux" }, async () => {
    await withEnv("CHROME_USER_DATA_DIR", undefined, async () => {
      const dirs = (await freshImport()).userDataDirCandidates();
      assert.ok(dirs.includes(join(homedir(), ".config/BraveSoftware/Brave-Browser")));
    });
  });

  test("A2 macos: Chrome dir present", { skip: process.platform !== "darwin" }, async () => {
    await withEnv("CHROME_USER_DATA_DIR", undefined, async () => {
      const dirs = (await freshImport()).userDataDirCandidates();
      const support = join(homedir(), "Library", "Application Support");
      assert.ok(dirs.includes(join(support, "Google/Chrome")));
    });
  });

  test("A2 macos: Brave dir present", { skip: process.platform !== "darwin" }, async () => {
    await withEnv("CHROME_USER_DATA_DIR", undefined, async () => {
      const dirs = (await freshImport()).userDataDirCandidates();
      const support = join(homedir(), "Library", "Application Support");
      assert.ok(dirs.includes(join(support, "BraveSoftware/Brave-Browser")));
    });
  });

  test("A2 macos: Edge dir present", { skip: process.platform !== "darwin" }, async () => {
    await withEnv("CHROME_USER_DATA_DIR", undefined, async () => {
      const dirs = (await freshImport()).userDataDirCandidates();
      const support = join(homedir(), "Library", "Application Support");
      assert.ok(dirs.includes(join(support, "Microsoft Edge")));
    });
  });

  test("A2 win: Chrome dir derives from %LOCALAPPDATA%", { skip: process.platform !== "win32" }, async () => {
    await withEnv("CHROME_USER_DATA_DIR", undefined, async () => {
      const dirs = (await freshImport()).userDataDirCandidates();
      const lad = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
      assert.ok(dirs.includes(join(lad, "Google/Chrome/User Data")));
    });
  });

  test("A2 win: Edge dir present", { skip: process.platform !== "win32" }, async () => {
    await withEnv("CHROME_USER_DATA_DIR", undefined, async () => {
      const dirs = (await freshImport()).userDataDirCandidates();
      const lad = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
      assert.ok(dirs.includes(join(lad, "Microsoft/Edge/User Data")));
    });
  });

  // A3: %LOCALAPPDATA% redirection is honoured (Windows-only behaviour)
  test("A3 win: redirected LOCALAPPDATA is used", { skip: process.platform !== "win32" }, async () => {
    await withEnv("LOCALAPPDATA", "D:\\Redirected\\Local", async () => {
      const dirs = (await freshImport()).userDataDirCandidates();
      assert.ok(dirs.some((d) => d.startsWith("D:\\Redirected\\Local") || d.startsWith("D:/Redirected/Local")));
    });
  });

  // A4: $CHROME_USER_DATA_DIR override leads the list. This value is ours to
  // interpret, so both tilde separators are accepted.
  test("A4: env override is first and tilde-expanded", async () => {
    await withEnv("CHROME_USER_DATA_DIR", join("~", "my-chrome-data"), async () => {
      const dirs = (await freshImport()).userDataDirCandidates();
      assert.equal(dirs[0], join(homedir(), "my-chrome-data"));
    });
  });

  test("A4: forward-slash tilde expands on every platform", async () => {
    await withEnv("CHROME_USER_DATA_DIR", "~/my-chrome-data", async () => {
      const dirs = (await freshImport()).userDataDirCandidates();
      assert.equal(dirs[0], join(homedir(), "my-chrome-data"));
    });
  });

  // A5: browser naming
  test("A5: Chrome recognised", async () => {
    const { browserNameForUserDataDir } = await freshImport();
    assert.equal(browserNameForUserDataDir("/home/u/.config/google-chrome"), "Chrome");
  });

  test("A5: Brave recognised", async () => {
    const { browserNameForUserDataDir } = await freshImport();
    assert.equal(browserNameForUserDataDir("/home/u/.config/BraveSoftware/Brave-Browser"), "Brave");
  });

  test("A5: Edge recognised through Windows separators", async () => {
    const { browserNameForUserDataDir } = await freshImport();
    assert.equal(browserNameForUserDataDir("C:\\Users\\u\\AppData\\Local\\Microsoft\\Edge\\User Data"), "Edge");
  });

  test("A5: Chromium beats Chrome", async () => {
    const { browserNameForUserDataDir } = await freshImport();
    assert.equal(browserNameForUserDataDir("/home/u/.config/chromium"), "Chromium");
  });
});
