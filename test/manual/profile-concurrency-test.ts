/**
 * Concurrency regression for harness tab creation, against a real browser.
 *
 * browser_read_page is registered unserialized, so several isolated tabs can be
 * opened at the same moment. Two risks live here:
 *
 *   1. Each concurrent caller finding "no harness window" and creating its own
 *      — two blank windows before profiles existed, two LAUNCHED profile windows
 *      after. ensureHarnessWindow single-flights per client to prevent it.
 *   2. Callers sharing that single creation and all claiming the same seed tab.
 *      Only the caller that started the creation may claim it; the rest must
 *      open their own tab beside it.
 *
 * Runs pinned and unpinned inside a throwaway --user-data-dir.
 *
 * Run: npx tsx test/manual/profile-concurrency-test.ts
 */
import { spawn, execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBrowserClient } from "../../src/client";
import { closeIsolatedTab, openIsolatedTab } from "../../src/domains/isolated-tab";

const PORT = Number(process.env["PROFILE_CONC_PORT"] ?? 9488);
const CONCURRENT_TABS = 5;

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
const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function findBrowser(): string | undefined {
  const fromEnv = process.env["CHROME_BIN"] ?? process.env["CHROME_PATH"];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;
  const candidates: string[] =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? [
            join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
            join(process.env["LOCALAPPDATA"] ?? "", "Google\\Chrome\\Application\\chrome.exe"),
          ]
        : ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];
  return candidates.find((c) => c && existsSync(c));
}

const killTree = (pid: number | undefined): void => {
  if (pid === undefined) return;
  if (process.platform === "win32") {
    try {
      execFileSync("taskkill.exe", ["/pid", String(pid), "/T", "/F"], { stdio: "ignore" });
    } catch {
      // already gone
    }
    return;
  }
  try {
    process.kill(-pid, "SIGKILL");
  } catch {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // already gone
    }
  }
};

async function scenario(exePath: string, label: string, pinned: boolean): Promise<void> {
  const udd = mkdtempSync(join(tmpdir(), "pi-profile-conc-"));
  const base = [
    `--user-data-dir=${udd}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--window-size=600,450",
  ];
  const browser = spawn(exePath, [...base, `--remote-debugging-port=${PORT}`, "about:blank"], {
    detached: true,
    stdio: "ignore",
  });
  browser.unref();

  try {
    let endpoint: string | undefined;
    for (let i = 0; i < 60 && !endpoint; i++) {
      await sleep(500);
      try {
        const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
        if (res.ok) endpoint = ((await res.json()) as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl;
      } catch {
        // not up yet
      }
    }
    if (!endpoint) {
      check(false, `${label}: browser exposed its DevTools endpoint`);
      return;
    }

    if (pinned) {
      // Materialise the profile the run pins to.
      spawn(exePath, [...base, "--profile-directory=Profile 2", "about:blank"], {
        detached: true,
        stdio: "ignore",
      }).unref();
      await sleep(6_000);
    }

    process.env["BU_CDP_WS"] = endpoint;
    const client = createBrowserClient({
      namespace: `conc-${pinned ? "pinned" : "plain"}`,
      ...(pinned
        ? { profilePin: { userDataDir: udd, profileDir: "Profile 2", label: "pinned", savedAt: "" } }
        : {}),
    });

    const started = await client.start();
    check(started.success, `${label}: client starts`);
    if (!started.success) return;

    const results = await Promise.all(Array.from({ length: CONCURRENT_TABS }, () => openIsolatedTab(client)));
    const tabs = results.flatMap((r) => (r.success ? [r.data] : []));
    check(tabs.length === CONCURRENT_TABS, `${label}: all ${CONCURRENT_TABS} concurrent tabs opened (${tabs.length})`);
    check(new Set(tabs.map((t) => t.targetId)).size === tabs.length, `${label}: every tab is a distinct target`);

    const windows = await Promise.all(
      tabs.map(async (t) => {
        const r = await client.session().callBrowser("Browser.getWindowForTarget", { targetId: t.targetId });
        return r.success ? (r.data as { windowId?: number }).windowId : undefined;
      }),
    );
    check(new Set(windows).size === 1, `${label}: all tabs share one window (${new Set(windows).size})`);

    if (pinned) {
      const contexts = await Promise.all(
        tabs.map(async (t) => {
          const r = await client.session().callBrowser("Target.getTargetInfo", { targetId: t.targetId });
          return r.success
            ? (r.data as { targetInfo?: { browserContextId?: string } }).targetInfo?.browserContextId
            : undefined;
        }),
      );
      check(
        new Set(contexts).size === 1 && contexts[0] === client.profileContextId(),
        `${label}: every tab is in the pinned profile`,
      );
    }

    for (const tab of tabs) await closeIsolatedTab(client, tab);
    await client.closeOwnedTabs();
    await client.stop();
  } finally {
    killTree(browser.pid);
    try {
      rmSync(udd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
      // a locked temp dir is not worth failing over
    }
  }
}

async function main(): Promise<void> {
  const exePath = findBrowser();
  if (!exePath) {
    console.error("No Chrome/Chromium found — set CHROME_BIN. Skipping.");
    process.exit(process.env["CI"] ? 1 : 0);
  }
  console.log(`browser: ${exePath}\n`);

  await scenario(exePath, "UNPINNED", false);
  await scenario(exePath, "PINNED", true);

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("profile concurrency test failed:", e);
  process.exit(1);
});
