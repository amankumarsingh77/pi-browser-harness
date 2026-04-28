/**
 * BrowserDaemon — manages the browser-harness daemon process lifecycle.
 *
 * Architecture:
 *   Node.js → Unix socket (/tmp/bu-<namespace>.sock) → daemon.py → CDP WS → Chrome
 *
 * The daemon is spawned as a child process on start() and communicates via
 * the protocol defined in protocol.ts. All CDP calls go through this class.
 */

import { spawn, type ChildProcess } from "node:child_process";
import { existsSync } from "node:fs";
import { access, readFile, unlink, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { basename, join } from "node:path";
import {
  sendRequest,
  daemonAlive,
  healthProbe,
  isInternalUrl,
  type CDPEvent,
  type DaemonRequest,
  type DaemonResponse,
  type DaemonStatus,
  type DialogInfo,
  type PageInfo,
  type PageInfoResult,
  type RemoteConfig,
  type TabInfo,
} from "./protocol";

// ── Constants ────────────────────────────────────────────────────────────────

/** Common locations where browser-harness might be cloned */
const BH_SEARCH_PATHS = [
  join(homedir(), "Developer", "browser-harness"),
  join(homedir(), "src", "browser-harness"),
  join(homedir(), "browser-harness"),
  join(homedir(), "dev", "browser-harness"),
  join(homedir(), "Projects", "browser-harness"),
];

const DAEMON_START_TIMEOUT_MS = 30_000;
const DAEMON_POLL_INTERVAL_MS = 200;
const DAEMON_SHUTDOWN_TIMEOUT_MS = 5_000;
const SESSION_ATTACH_TIMEOUT_MS = 5_000;

const VIRTUAL_KEY_CODES: Record<string, number> = {
  Enter: 13,
  Tab: 9,
  Backspace: 8,
  Escape: 27,
  Delete: 46,
  " ": 32,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
  PageUp: 33,
  PageDown: 34,
};

// ── BrowserDaemon ────────────────────────────────────────────────────────────

export class BrowserDaemon {
  readonly namespace: string;
  readonly socketPath: string;
  readonly pidPath: string;
  readonly logPath: string;

  private proc: ChildProcess | null = null;
  private _sessionId: string | null = null;
  private _pid: number | null = null;
  private remote: RemoteConfig | null = null;

  constructor(namespace = "default", remote?: RemoteConfig) {
    this.namespace = namespace;
    this.socketPath = `/tmp/bu-${namespace}.sock`;
    this.pidPath = `/tmp/bu-${namespace}.pid`;
    this.logPath = `/tmp/bu-${namespace}.log`;
    this.remote = remote ?? null;
  }

  // ── Public getters ───────────────────────────────────────────────────────

  get sessionId(): string | null {
    return this._sessionId;
  }

  get pid(): number | null {
    return this._pid;
  }

  getStatus(): DaemonStatus {
    return {
      alive: this._sessionId !== null,
      sessionId: this._sessionId,
      pid: this._pid,
      namespace: this.namespace,
      socketPath: this.socketPath,
      remoteBrowserId: this.remote?.browserId,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Start the daemon process and wait for it to become ready.
   * Idempotent — returns immediately if already alive and healthy.
   */
  async start(): Promise<void> {
    // Already healthy?
    if (await healthProbe(this.socketPath)) {
      await this.refreshSessionId();
      return;
    }

    // Stale socket but daemon alive? Stop it first.
    if (await daemonAlive(this.socketPath)) {
      await this.stop();
    }

    const bhDir = await findBrowserHarnessDir();
    const env = this.buildEnv();

    this.proc = spawn("uv", ["run", "daemon.py"], {
      cwd: bhDir,
      env: { ...process.env, ...env },
      stdio: ["ignore", "ignore", "ignore"],
      detached: true,
    });
    this.proc.unref();

    if (this.proc.pid) {
      this._pid = this.proc.pid;
    }

    // Poll until socket accepts connections
    const deadline = Date.now() + DAEMON_START_TIMEOUT_MS;
    let lastError = "";

    while (Date.now() < deadline) {
      if (this.proc.exitCode !== null) {
        lastError = await this.readLogTail();
        throw new Error(
          `Browser daemon exited (code ${this.proc.exitCode}): ${lastError || "unknown error"}`,
        );
      }

      if (await daemonAlive(this.socketPath)) {
        // Verify CDP is healthy (not just socket)
        if (await healthProbe(this.socketPath)) {
          await this.refreshSessionId();
          return;
        }
        // Socket alive but CDP not ready — keep polling
      }

      await sleep(DAEMON_POLL_INTERVAL_MS);
    }

    lastError = await this.readLogTail();
    // Check if Chrome needs remote debugging setup
    if (this.needsChromeSetup(lastError)) {
      throw new Error(
        `Chrome remote debugging not enabled. Start Chrome with --remote-debugging-port=9222, then retry.\n\nDaemon log: ${lastError}`,
      );
    }

    throw new Error(
      `Daemon "${this.namespace}" failed to start after ${DAEMON_START_TIMEOUT_MS / 1000}s. ` +
        `Log: ${lastError || "no log output"}`,
    );
  }

  /**
   * Gracefully stop the daemon: send shutdown, wait for exit, force-kill if needed.
   */
  async stop(): Promise<void> {
    // Send shutdown via socket
    try {
      await sendRequest(this.socketPath, { meta: "shutdown" }, 3000);
    } catch {
      // Socket may already be dead — that's fine
    }

    // Wait for process to exit
    if (this.proc && this.proc.exitCode === null) {
      const deadline = Date.now() + DAEMON_SHUTDOWN_TIMEOUT_MS;
      while (Date.now() < deadline) {
        if (this.proc.exitCode !== null) break;
        await sleep(100);
      }

      // Force kill if still alive
      if (this.proc.exitCode === null) {
        try {
          this.proc.kill("SIGTERM");
        } catch {
          // already dead
        }
      }
    }

    // Clean up files
    for (const f of [this.socketPath, this.pidPath]) {
      try {
        await unlink(f);
      } catch {
        // file doesn't exist
      }
    }

    this.proc = null;
    this._sessionId = null;
    this._pid = null;
  }

  /**
   * Ensure daemon is alive and healthy. Restarts if stale.
   * Call before every tool execution.
   */
  async ensureAlive(): Promise<void> {
    if (!(await healthProbe(this.socketPath))) {
      await this.stop();
      await this.start();
    }
  }

  // ── CDP Communication ────────────────────────────────────────────────────

  /**
   * Send a raw request to the daemon and get the response.
   */
  async send(request: DaemonRequest): Promise<DaemonResponse> {
    await this.ensureAlive();

    try {
      const response = await sendRequest(this.socketPath, request);
      return response;
    } catch (err) {
      // Socket died mid-request — restart and retry once
      const message = err instanceof Error ? err.message : String(err);
      if (message.includes("ENOENT") || message.includes("ECONNREFUSED") || message.includes("EPIPE")) {
        await this.stop();
        await this.start();
        return sendRequest(this.socketPath, request);
      }
      throw err;
    }
  }

  /**
   * Convenience: send a CDP method and return the result.
   * Handles session management — Target.* methods skip session,
   * others use explicit sessionId or the daemon's default session.
   */
  async cdp(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string | null,
  ): Promise<unknown> {
    // Browser-level Target.* calls must NOT use a session
    const sid = method.startsWith("Target.") ? null : (sessionId ?? this._sessionId);

    const response = await this.send({
      method,
      params: params ?? {},
      session_id: sid,
    });

    if (response.error) {
      // Auto-recover from stale session
      if (
        response.error.includes("Session with given id not found") &&
        sid === this._sessionId
      ) {
        await this.attachFirstPage();
        const retry = await this.send({
          method,
          params: params ?? {},
          session_id: this._sessionId,
        });
        if (retry.error) {
          throw new Error(`CDP error after session recovery (${method}): ${retry.error}`);
        }
        return retry.result;
      }
      throw new Error(`CDP error (${method}): ${response.error}`);
    }

    return response.result;
  }

  // ── High-level Browser Helpers ────────────────────────────────────────────

  /** Get page state or dialog info */
  async getPageInfo(): Promise<PageInfoResult> {
    // Check for JS dialog first
    try {
      const dialogResp = await sendRequest(this.socketPath, { meta: "pending_dialog" });
      if (dialogResp.dialog) {
        return { dialog: dialogResp.dialog };
      }
    } catch {
      // ignore — dialog check is best-effort
    }

    const js = `JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})`;
    const raw = await this.evaluateJS(js);
    return JSON.parse(raw as string) as PageInfo;
  }

  /** Capture a PNG screenshot, write to path, return path */
  async captureScreenshot(outputPath: string, fullPage = false): Promise<string> {
    const result = (await this.cdp("Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: fullPage,
    })) as { data: string };

    const buf = Buffer.from(result.data, "base64");
    await writeFile(outputPath, buf);
    return outputPath;
  }

  /** List browser tabs */
  async listTabs(includeChrome = true): Promise<TabInfo[]> {
    const result = (await this.cdp("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string; title: string; url: string }>;
    };

    const tabs: TabInfo[] = [];
    for (const t of result.targetInfos) {
      if (t.type !== "page") continue;
      if (!includeChrome && isInternalUrl(t.url)) continue;
      tabs.push({ targetId: t.targetId, title: t.title || "", url: t.url || "" });
    }
    return tabs;
  }

  /** Get current tab info */
  async currentTab(): Promise<TabInfo> {
    const result = (await this.cdp("Target.getTargetInfo")) as {
      targetInfo: { targetId: string; url: string; title: string };
    };
    const t = result.targetInfo;
    return { targetId: t.targetId, url: t.url || "", title: t.title || "" };
  }

  /** Create a new tab and switch to it. Optionally navigate. */
  async newTab(url?: string): Promise<string> {
    const result = (await this.cdp("Target.createTarget", {
      url: "about:blank",
    })) as { targetId: string };

    await this.switchTab(result.targetId);
    if (url && url !== "about:blank") {
      await this.cdp("Page.navigate", { url });
    }
    return result.targetId;
  }

  /** Activate and attach to a tab */
  async switchTab(targetId: string): Promise<void> {
    await this.cdp("Target.activateTarget", { targetId });
    const result = (await this.cdp("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };

    // Tell the daemon to use this as default session
    this._sessionId = result.sessionId;
    await sendRequest(this.socketPath, {
      meta: "set_session",
      session_id: result.sessionId,
    });

    // Mark the tab with a green circle for user visibility
    try {
      await this.cdp("Runtime.evaluate", {
        expression: `if(!document.title.startsWith('🟢'))document.title='🟢 '+document.title`,
      });
    } catch {
      // best-effort
    }
  }

  /** Evaluate JavaScript in the page (or a specific iframe target) */
  async evaluateJS(expression: string, targetId?: string): Promise<unknown> {
    // Auto-wrap return statements in IIFE
    if (expression.includes("return ") && !expression.trim().startsWith("(")) {
      expression = `(function(){${expression}})()`;
    }

    const sid = targetId || null; // explicit target or daemon default
    const result = (await this.cdp(
      "Runtime.evaluate",
      {
        expression,
        returnByValue: true,
        awaitPromise: true,
      },
      targetId ? sid : undefined,
    )) as { result?: { value?: unknown }; exceptionDetails?: unknown };

    if (result.exceptionDetails) {
      throw new Error(`JS evaluation failed: ${JSON.stringify(result.exceptionDetails)}`);
    }
    return result.result?.value;
  }

  /** Drain buffered CDP events from the daemon */
  async drainEvents(): Promise<CDPEvent[]> {
    const resp = await sendRequest(this.socketPath, { meta: "drain_events" });
    return resp.events ?? [];
  }

  /** Get virtual key code for a key name or character */
  getVirtualKeyCode(key: string): number {
    return VIRTUAL_KEY_CODES[key] ?? (key.length === 1 ? key.charCodeAt(0) : 0);
  }

  /** Get the key code string for CDP (uses the key name or the key itself) */
  getKeyCode(key: string): string {
    return key.length === 1 && !VIRTUAL_KEY_CODES[key] ? key : key;
  }

  // ── Internal Helpers ──────────────────────────────────────────────────────

  /** Attach to the first real page target. Creates about:blank if none exist. */
  private async attachFirstPage(): Promise<string> {
    const result = (await this.cdp("Target.getTargets")) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };

    const pages = result.targetInfos.filter(
      (t) => t.type === "page" && !isInternalUrl(t.url),
    );

    if (pages.length === 0) {
      const created = (await this.cdp("Target.createTarget", {
        url: "about:blank",
      })) as { targetId: string };
      pages.push({ targetId: created.targetId, type: "page", url: "about:blank" });
    }

    const attachResult = (await this.cdp("Target.attachToTarget", {
      targetId: pages[0].targetId,
      flatten: true,
    })) as { sessionId: string };

    this._sessionId = attachResult.sessionId;

    // Enable core domains
    for (const domain of ["Page", "DOM", "Runtime", "Network"]) {
      try {
        await this.cdp(`${domain}.enable`);
      } catch {
        // best-effort
      }
    }

    return attachResult.sessionId;
  }

  /** Refresh session ID from the daemon's current session */
  private async refreshSessionId(): Promise<void> {
    try {
      const resp = await sendRequest(this.socketPath, { meta: "session" });
      if (resp.session_id) {
        this._sessionId = resp.session_id;
      }
    } catch {
      // will be set on first attach
    }
  }

  /** Build environment variables for the daemon process */
  private buildEnv(): Record<string, string> {
    const env: Record<string, string> = {
      BU_NAME: this.namespace,
    };

    if (this.remote) {
      env.BU_CDP_WS = this.remote.cdpUrl;
      env.BU_BROWSER_ID = this.remote.browserId;
    }

    return env;
  }

  /** Read the last line of the daemon log */
  private async readLogTail(): Promise<string> {
    try {
      const content = await readFile(this.logPath, "utf-8");
      const lines = content.trim().split("\n");
      return lines[lines.length - 1] || "";
    } catch {
      return "";
    }
  }

  /** Check if the error message suggests Chrome needs remote debugging setup */
  private needsChromeSetup(errorMsg: string): boolean {
    const lower = errorMsg.toLowerCase();
    return (
      lower.includes("devtoolsactiveport not found") ||
      lower.includes("enable chrome://inspect") ||
      lower.includes("not live yet") ||
      (lower.includes("ws handshake failed") &&
        (lower.includes("403") || lower.includes("timed out")))
    );
  }
}

// ── Utility ──────────────────────────────────────────────────────────────────

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * Find the browser-harness repository directory.
 * Searches common locations and falls back to cwd.
 */
async function findBrowserHarnessDir(): Promise<string> {
  // Check common locations
  for (const dir of BH_SEARCH_PATHS) {
    if (
      existsSync(join(dir, "daemon.py")) &&
      existsSync(join(dir, "helpers.py"))
    ) {
      return dir;
    }
  }

  // Check cwd
  const cwd = process.cwd();
  if (existsSync(join(cwd, "daemon.py")) && existsSync(join(cwd, "helpers.py"))) {
    return cwd;
  }

  throw new Error(
    "browser-harness not found. Clone it first:\n" +
      "  git clone https://github.com/browser-use/browser-harness ~/Developer/browser-harness\n" +
      "  cd ~/Developer/browser-harness && uv sync\n\n" +
      `Searched: ${BH_SEARCH_PATHS.join(", ")}`,
  );
}
