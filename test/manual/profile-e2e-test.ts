import { spawn, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { listProfiles } from "../../src/profile/list";
import { openProfileWindow } from "../../src/profile/launch";

const PORT = Number(process.env["PROFILE_E2E_PORT"] ?? 9444);

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

function findBrowser(): string | undefined {
  const fromEnv = process.env["CHROME_BIN"] ?? process.env["CHROME_PATH"];
  if (fromEnv && existsSync(fromEnv)) return fromEnv;

  const candidates: string[] =
    process.platform === "darwin"
      ? [
          "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
          "/Applications/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing",
          "/Applications/Chromium.app/Contents/MacOS/Chromium",
        ]
      : process.platform === "win32"
        ? [
            join(process.env["PROGRAMFILES"] ?? "C:\\Program Files", "Google\\Chrome\\Application\\chrome.exe"),
            join(process.env["PROGRAMFILES(X86)"] ?? "C:\\Program Files (x86)", "Google\\Chrome\\Application\\chrome.exe"),
            join(process.env["LOCALAPPDATA"] ?? "", "Google\\Chrome\\Application\\chrome.exe"),
          ]
        : ["/opt/google/chrome/chrome", "/usr/bin/google-chrome", "/usr/bin/chromium", "/usr/bin/chromium-browser"];

  for (const candidate of candidates) {
    if (candidate && existsSync(candidate)) return candidate;
  }
  if (process.platform === "linux") {
    for (const name of ["google-chrome", "chromium", "chromium-browser"]) {
      try {
        const resolved = execFileSync("which", [name], { encoding: "utf8" }).trim();
        if (resolved) return resolved;
      } catch {
      }
    }
  }
  return undefined;
}

type Cdp = {
  call: (method: string, params?: Record<string, unknown>, sessionId?: string) => Promise<any>;
  close: () => void;
};

async function connectCdp(): Promise<Cdp> {
  const version = await (await fetch(`http://127.0.0.1:${PORT}/json/version`)).json();
  const ws = new WebSocket((version as { webSocketDebuggerUrl: string }).webSocketDebuggerUrl, {
    maxPayload: 64 * 1024 * 1024,
  });
  let id = 0;
  const pending = new Map<number, (v: any) => void>();
  ws.on("message", (d) => {
    const m = JSON.parse(d.toString());
    if (m.id && pending.has(m.id)) {
      pending.get(m.id)!(m);
      pending.delete(m.id);
    }
  });
  await new Promise<void>((resolve, reject) => {
    ws.once("open", () => resolve());
    ws.once("error", reject);
  });
  return {
    call: (method, params = {}, sessionId) =>
      new Promise((resolve) => {
        const myId = ++id;
        pending.set(myId, resolve);
        ws.send(JSON.stringify({ id: myId, method, params, ...(sessionId ? { sessionId } : {}) }));
      }),
    close: () => ws.close(),
  };
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

async function waitForEndpoint(deadlineMs = 30_000): Promise<boolean> {
  const end = Date.now() + deadlineMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${PORT}/json/version`);
      if (res.ok) return true;
    } catch {
    }
    await sleep(500);
  }
  return false;
}

async function main(): Promise<void> {
  const exePath = findBrowser();
  if (!exePath) {
    console.error("No Chrome/Chromium found — set CHROME_BIN. Skipping.");
    process.exit(process.env["CI"] ? 1 : 0);
  }
  console.log(`browser: ${exePath}\n`);

  const udd = mkdtempSync(join(tmpdir(), "pi-profile-e2e-"));
  const baseArgs = [
    `--user-data-dir=${udd}`,
    "--no-first-run",
    "--no-default-browser-check",
    "--disable-sync",
    "--disable-background-networking",
    "--window-size=600,450",
  ];

  const browser = spawn(exePath, [...baseArgs, `--remote-debugging-port=${PORT}`, "about:blank"], {
    detached: true,
    stdio: "ignore",
  });
  browser.unref();

  const cleanup = (): void => {
    // Any surviving child keeps the user-data-dir locked, which on Windows also blocks the directory removal.
    if (process.platform === "win32") {
      try {
        execFileSync("taskkill.exe", ["/pid", String(browser.pid), "/T", "/F"], { stdio: "ignore" });
      } catch {
      }
    } else {
      try {
        // detached:true put the browser in its own process group, so the negative pid signals the whole group.
        process.kill(-browser.pid!, "SIGKILL");
      } catch {
        try {
          browser.kill("SIGKILL");
        } catch {
        }
      }
    }
    try {
      rmSync(udd, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
    } catch {
    }
  };

  try {
    if (!(await waitForEndpoint())) {
      console.error("browser never exposed its DevTools endpoint");
      cleanup();
      process.exit(1);
    }

    const second = spawn(exePath, [...baseArgs, "--profile-directory=Profile 2", "about:blank"], {
      detached: true,
      stdio: "ignore",
    });
    second.unref();
    await sleep(6_000);

    const cdp = await connectCdp();
    const pageTargets = async (): Promise<any[]> =>
      ((await cdp.call("Target.getTargets")).result?.targetInfos ?? []).filter((t: any) => t.type === "page");
    const windowOf = async (targetId: string): Promise<number | undefined> =>
      (await cdp.call("Browser.getWindowForTarget", { targetId })).result?.windowId;

    // Chrome flushes Local State asynchronously, so a just-created profile is not registered yet — poll rather than read once.
    let profiles = await listProfiles(udd);
    const enumDeadline = Date.now() + 30_000;
    while (Date.now() < enumDeadline && profiles.length < 2) {
      await sleep(1_000);
      profiles = await listProfiles(udd);
    }
    const dirs = profiles.map((p) => p.dir).sort();
    check(dirs.includes("Default"), "E1: Default profile enumerated from Local State");
    check(dirs.includes("Profile 2"), "E1: second profile enumerated from Local State");
    check(
      profiles.length >= 2 && profiles.every((p) => /^.+ \(.+\)$/.test(p.label)),
      "E1: every profile has a 'Name (…)' label",
    );

    const contexts = new Set((await pageTargets()).map((t) => t.browserContextId));
    check(contexts.size >= 2, `E2: profiles surface as distinct browserContextIds (${contexts.size} seen)`);

    const launched = await openProfileWindow({ exePath, profileDir: "Profile 2", explicitUserDataDir: udd });
    check(launched.success, "E3: profile window launch dispatched");
    if (!launched.success) throw new Error(launched.error);

    const deadline = Date.now() + 20_000;
    let seed: any;
    while (Date.now() < deadline && !seed) {
      await sleep(500);
      seed = (await pageTargets()).find((t) => t.url === launched.data.sentinelUrl);
    }
    check(!!seed, "E3: sentinel page identifies the new profile window");
    if (!seed) throw new Error("sentinel target never appeared");
    await launched.data.cleanup();

    const seedWindow = await windowOf(seed.targetId);
    const seedContext = seed.browserContextId;
    check(typeof seedContext === "string" && seedContext.length > 0, "E3: seed carries the profile's browserContextId");

    const attached = await cdp.call("Target.attachToTarget", { targetId: seed.targetId, flatten: true });
    const sessionId = attached.result?.sessionId;
    check(!!sessionId, "E4: seed page in a non-default profile is attachable");

    const token = `pi-e2e-${Date.now()}`;
    const opened = await cdp.call(
      "Runtime.evaluate",
      {
        expression: `!!window.open('about:blank#${token}', '_blank')`,
        returnByValue: true,
        userGesture: true,
      },
      sessionId,
    );
    check(opened.result?.result?.value === true, "E4: window.open with userGesture is not blocked");

    let spawned: any;
    const spawnDeadline = Date.now() + 10_000;
    while (Date.now() < spawnDeadline && !spawned) {
      await sleep(200);
      spawned = (await pageTargets()).find((t) => t.url.includes(token));
    }
    check(!!spawned, "E4: spawned tab is found by its unique token");
    if (!spawned) throw new Error("spawned tab never appeared");

    check(spawned.browserContextId === seedContext, "E4: spawned tab stays in the pinned profile");
    check((await windowOf(spawned.targetId)) === seedWindow, "E4: spawned tab stays in the harness window");

    const attachSpawned = await cdp.call("Target.attachToTarget", { targetId: spawned.targetId, flatten: true });
    check(!!attachSpawned.result?.sessionId, "E5: spawned tab is attachable");
    const navigated = await cdp.call(
      "Page.navigate",
      { url: "about:blank#navigated" },
      attachSpawned.result.sessionId,
    );
    check(!navigated.error, "E5: spawned tab is navigable");
    const closed = await cdp.call("Target.closeTarget", { targetId: spawned.targetId });
    check(closed.result?.success === true, "E5: spawned tab is closable");

    cdp.close();
  } finally {
    cleanup();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error("profile e2e test failed:", e);
  process.exit(1);
});
