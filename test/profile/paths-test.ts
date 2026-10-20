import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { agentDir, browserNameForUserDataDir, pinFilePath, userDataDirCandidates } from "../../src/profile/paths";

const withEnv = (key: string, value: string | undefined, fn: () => void): void => {
  const saved = process.env[key];
  // Assigning undefined would store the string "undefined", so a cleared variable is deleted.
  if (value === undefined) Reflect.deleteProperty(process.env, key);
  else process.env[key] = value;
  try {
    fn();
  } finally {
    if (saved === undefined) Reflect.deleteProperty(process.env, key);
    else process.env[key] = saved;
  }
};

describe("path resolution", () => {
  test("A1: default agent dir is ~/.pi/agent", () => {
    withEnv("PI_CODING_AGENT_DIR", undefined, () => {
            assert.equal(agentDir(), join(homedir(), ".pi", "agent"));
    });
  });

  test("A1: pin file sits in it", () => {
    withEnv("PI_CODING_AGENT_DIR", undefined, () => {
            assert.equal(pinFilePath(), join(homedir(), ".pi", "agent", "browser-harness.json"));
    });
  });

  test("A1: '~/' in the agent-dir override expands like pi", () => {
    withEnv("PI_CODING_AGENT_DIR", "~/custom-agent", () => {
      assert.equal(agentDir(), `${homedir()}/custom-agent`);
    });
  });

  test("A1 win: '~\\' is left alone, matching pi's own resolution", { skip: process.platform !== "win32" }, () => {
    withEnv("PI_CODING_AGENT_DIR", "~\\custom-agent", () => {
      assert.equal(agentDir(), "~\\custom-agent");
    });
  });

  test("A2: candidates are non-empty on this platform", () => {
    withEnv("CHROME_USER_DATA_DIR", undefined, () => {
      const dirs = userDataDirCandidates();
      assert.ok(dirs.length > 0);
    });
  });

  test("A2: candidate list is de-duplicated", () => {
    withEnv("CHROME_USER_DATA_DIR", undefined, () => {
      const dirs = userDataDirCandidates();
      assert.equal(new Set(dirs).size, dirs.length);
    });
  });

  test("A2 linux: Chrome stable dir present", { skip: process.platform !== "linux" }, () => {
    withEnv("CHROME_USER_DATA_DIR", undefined, () => {
      const dirs = userDataDirCandidates();
      assert.ok(dirs.includes(join(homedir(), ".config/google-chrome")));
    });
  });

  test("A2 linux: snap Chromium dir present", { skip: process.platform !== "linux" }, () => {
    withEnv("CHROME_USER_DATA_DIR", undefined, () => {
      const dirs = userDataDirCandidates();
      assert.ok(dirs.includes(join(homedir(), "snap/chromium/common/chromium")));
    });
  });

  test("A2 linux: Brave dir present", { skip: process.platform !== "linux" }, () => {
    withEnv("CHROME_USER_DATA_DIR", undefined, () => {
      const dirs = userDataDirCandidates();
      assert.ok(dirs.includes(join(homedir(), ".config/BraveSoftware/Brave-Browser")));
    });
  });

  test("A2 macos: Chrome dir present", { skip: process.platform !== "darwin" }, () => {
    withEnv("CHROME_USER_DATA_DIR", undefined, () => {
      const dirs = userDataDirCandidates();
      const support = join(homedir(), "Library", "Application Support");
      assert.ok(dirs.includes(join(support, "Google/Chrome")));
    });
  });

  test("A2 macos: Brave dir present", { skip: process.platform !== "darwin" }, () => {
    withEnv("CHROME_USER_DATA_DIR", undefined, () => {
      const dirs = userDataDirCandidates();
      const support = join(homedir(), "Library", "Application Support");
      assert.ok(dirs.includes(join(support, "BraveSoftware/Brave-Browser")));
    });
  });

  test("A2 macos: Edge dir present", { skip: process.platform !== "darwin" }, () => {
    withEnv("CHROME_USER_DATA_DIR", undefined, () => {
      const dirs = userDataDirCandidates();
      const support = join(homedir(), "Library", "Application Support");
      assert.ok(dirs.includes(join(support, "Microsoft Edge")));
    });
  });

  test("A2 win: Chrome dir derives from %LOCALAPPDATA%", { skip: process.platform !== "win32" }, () => {
    withEnv("CHROME_USER_DATA_DIR", undefined, () => {
      const dirs = userDataDirCandidates();
      const lad = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
      assert.ok(dirs.includes(join(lad, "Google/Chrome/User Data")));
    });
  });

  test("A2 win: Edge dir present", { skip: process.platform !== "win32" }, () => {
    withEnv("CHROME_USER_DATA_DIR", undefined, () => {
      const dirs = userDataDirCandidates();
      const lad = process.env["LOCALAPPDATA"] ?? join(homedir(), "AppData", "Local");
      assert.ok(dirs.includes(join(lad, "Microsoft/Edge/User Data")));
    });
  });

  test("A3 win: redirected LOCALAPPDATA is used", { skip: process.platform !== "win32" }, () => {
    withEnv("LOCALAPPDATA", "D:\\Redirected\\Local", () => {
      const dirs = userDataDirCandidates();
      assert.ok(dirs.some((d) => d.startsWith("D:\\Redirected\\Local") || d.startsWith("D:/Redirected/Local")));
    });
  });

  test("A4: env override is first and tilde-expanded", () => {
    withEnv("CHROME_USER_DATA_DIR", join("~", "my-chrome-data"), () => {
      const dirs = userDataDirCandidates();
      assert.equal(dirs[0], join(homedir(), "my-chrome-data"));
    });
  });

  test("A4: forward-slash tilde expands on every platform", () => {
    withEnv("CHROME_USER_DATA_DIR", "~/my-chrome-data", () => {
      const dirs = userDataDirCandidates();
      assert.equal(dirs[0], join(homedir(), "my-chrome-data"));
    });
  });

  test("A5: Chrome recognised", () => {
        assert.equal(browserNameForUserDataDir("/home/u/.config/google-chrome"), "Chrome");
  });

  test("A5: Brave recognised", () => {
        assert.equal(browserNameForUserDataDir("/home/u/.config/BraveSoftware/Brave-Browser"), "Brave");
  });

  test("A5: Edge recognised through Windows separators", () => {
        assert.equal(browserNameForUserDataDir("C:\\Users\\u\\AppData\\Local\\Microsoft\\Edge\\User Data"), "Edge");
  });

  test("A5: Chromium beats Chrome", () => {
        assert.equal(browserNameForUserDataDir("/home/u/.config/chromium"), "Chromium");
  });
});
