/**
 * BrowserDaemon — manages a direct CDP WebSocket connection to Chrome.
 *
 * Architecture:
 *   Node.js → CDP WebSocket (ws://localhost:9222/...) → Chrome
 *
 * No Python proxy, no Unix socket. Direct CDP over a single persistent
 * WebSocket with message-ID multiplexing, auto-reconnect, and event buffering.
 */

import { readFile, writeFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { connect as netConnect } from "node:net";
import WebSocket from "ws";
import {
  type CDPEvent,
  type DaemonStatus,
  type DialogInfo,
  type PageInfo,
  type PageInfoResult,
  type RemoteConfig,
  type TabInfo,
  isInternalUrl,
} from "./protocol";

// ── Constants ────────────────────────────────────────────────────────────────

const CDP_CONNECT_TIMEOUT_MS = 10_000;
const CDP_REQUEST_TIMEOUT_MS = 15_000;
const CDP_RECONNECT_BASE_MS = 500;
const CDP_MAX_RECONNECT_ATTEMPTS = 5;
const PORT_PROBE_DEADLINE_MS = 30_000;
const PORT_PROBE_INTERVAL_MS = 1_000;

/**
 * Discover Chrome's CDP WebSocket URL by reading the per-profile
 * `DevToolsActivePort` file written when remote debugging is enabled
 * via chrome://inspect/#remote-debugging. Mirrors browser-harness/daemon.py.
 */
async function discoverWsUrl(): Promise<string> {
  const dirs = chromeProfileDirs();
  const tried: string[] = [];
  for (const base of dirs) {
    const portFile = join(base, "DevToolsActivePort");
    let raw: string;
    try {
      raw = await readFile(portFile, "utf8");
    } catch {
      continue;
    }
    tried.push(base);
    const lines = raw.trim().split("\n");
    if (lines.length < 2) continue;
    const port = lines[0].trim();
    const path = lines[1].trim();
    if (!port || !path) continue;

    await waitForPort(Number(port));
    return `ws://127.0.0.1:${port}${path}`;
  }
  throw new Error(
    `DevToolsActivePort not found in ${dirs.join(", ")} — open chrome://inspect/#remote-debugging in your browser, tick the checkbox, click Allow, then retry. Or set BU_CDP_WS to a remote browser endpoint.`,
  );
}

/** Probe TCP port until reachable or deadline expires. */
async function waitForPort(port: number): Promise<void> {
  const deadline = Date.now() + PORT_PROBE_DEADLINE_MS;
  let lastErr: Error | null = null;
  while (Date.now() < deadline) {
    try {
      await new Promise<void>((resolve, reject) => {
        const sock = netConnect({ host: "127.0.0.1", port });
        const onError = (err: Error) => {
          sock.destroy();
          reject(err);
        };
        sock.setTimeout(1000, () => onError(new Error("probe timeout")));
        sock.once("error", onError);
        sock.once("connect", () => {
          sock.end();
          resolve();
        });
      });
      return;
    } catch (err) {
      lastErr = err instanceof Error ? err : new Error(String(err));
      await new Promise((r) => setTimeout(r, PORT_PROBE_INTERVAL_MS));
    }
  }
  throw new Error(
    `Chrome's remote-debugging page is open, but DevTools is not live yet on 127.0.0.1:${port} — if Chrome opened a profile picker, choose your normal profile first, then tick the checkbox and click Allow if shown (last error: ${lastErr?.message ?? "unknown"})`,
  );
}

// Chrome / Edge / Chromium profile directories that may contain DevToolsActivePort.
// Mirrors browser-harness/daemon.py PROFILES.
function chromeProfileDirs(): string[] {
  const home = homedir();
  return [
    join(home, "Library/Application Support/Google/Chrome"),
    join(home, "Library/Application Support/Microsoft Edge"),
    join(home, "Library/Application Support/Microsoft Edge Beta"),
    join(home, "Library/Application Support/Microsoft Edge Dev"),
    join(home, "Library/Application Support/Microsoft Edge Canary"),
    join(home, ".config/google-chrome"),
    join(home, ".config/chromium"),
    join(home, ".config/chromium-browser"),
    join(home, ".config/microsoft-edge"),
    join(home, ".config/microsoft-edge-beta"),
    join(home, ".config/microsoft-edge-dev"),
    join(home, ".var/app/org.chromium.Chromium/config/chromium"),
    join(home, ".var/app/com.google.Chrome/config/google-chrome"),
    join(home, ".var/app/com.brave.Browser/config/BraveSoftware/Brave-Browser"),
    join(home, ".var/app/com.microsoft.Edge/config/microsoft-edge"),
    join(home, "AppData/Local/Google/Chrome/User Data"),
    join(home, "AppData/Local/Chromium/User Data"),
    join(home, "AppData/Local/Microsoft/Edge/User Data"),
    join(home, "AppData/Local/Microsoft/Edge Beta/User Data"),
    join(home, "AppData/Local/Microsoft/Edge Dev/User Data"),
    join(home, "AppData/Local/Microsoft/Edge SxS/User Data"),
  ];
}

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

  private ws: WebSocket | null = null;
  private _sessionId: string | null = null;
  private _targetId: string | null = null;
  private _currentDialog: DialogInfo | null = null;
  private _eventBuffer: CDPEvent[] = [];
  private _pending = new Map<number, PendingRequest>();
  private _nextId = 1;
  private _connectResolve: ((v: void) => void) | null = null;
  private _connectReject: ((err: Error) => void) | null = null;
  private _connectTimer: ReturnType<typeof setTimeout> | null = null;
  private _reconnectAttempts = 0;
  private _stopping = false;
  private _consentObserved = false;
  private remote: RemoteConfig | null = null;

  // ── Performance optimizations ──────────────────────────────────────────
  private _lastHealthCheck = 0;
  private readonly HEALTH_CHECK_TTL_MS = 30_000;
  private _cachedPageInfo: PageInfo | null = null;
  private _cachedPageInfoTime = 0;
  private readonly PAGE_INFO_TTL_MS = 1_000;
  private _lastOperationFailed = false;

  constructor(namespace = "default", remote?: RemoteConfig) {
    this.namespace = namespace;
    this.remote = remote ?? null;
  }

  // ── Public getters ───────────────────────────────────────────────────────

  get sessionId(): string | null {
    return this._sessionId;
  }

  getStatus(): DaemonStatus {
    return {
      alive: this._sessionId !== null && this.ws?.readyState === WebSocket.OPEN,
      sessionId: this._sessionId,
      pid: null,
      namespace: this.namespace,
      socketPath: "",
      remoteBrowserId: this.remote?.browserId,
    };
  }

  // ── Lifecycle ────────────────────────────────────────────────────────────

  /**
   * Connect to Chrome via CDP WebSocket.
   * Idempotent — returns immediately if already connected and healthy.
   */
  async start(): Promise<void> {
    if (this._sessionId && this.ws?.readyState === WebSocket.OPEN) {
      return; // Already connected
    }

    this._stopping = false;
    this._reconnectAttempts = 0;

    try {
      await this.connect();
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (this.needsChromeSetup(msg)) {
        throw new Error(
          `Chrome remote debugging not enabled. Open chrome://inspect/#remote-debugging and tick the Allow checkbox, then retry.\n\nDetails: ${msg}`,
        );
      }
      throw err;
    }
  }

  /**
   * Gracefully disconnect from Chrome.
   */
  async stop(): Promise<void> {
    this._stopping = true;

    // Reject any pending connect
    if (this._connectReject) {
      this._connectReject(new Error("Daemon stopped"));
      this._connectReject = null;
    }
    if (this._connectTimer) {
      clearTimeout(this._connectTimer);
      this._connectTimer = null;
    }

    // Reject all pending requests
    for (const [id, req] of this._pending) {
      req.reject(new Error("Daemon stopped"));
      this._pending.delete(id);
    }

    // Close the WebSocket
    if (this.ws) {
      try {
        this.ws.close(1000, "Shutdown");
      } catch {
        // best-effort
      }
      this.ws = null;
    }

    this._sessionId = null;
    this._targetId = null;
    this._currentDialog = null;
    this._eventBuffer = [];
    this._consentObserved = false;
  }

  /**
   * Ensure daemon is alive and healthy. Reconnects if stale.
   * Call before every tool execution.
   *
   * OPTIMIZED: Fast path checks WebSocket state + short TTL. Only does
   * a full CDP health check every HEALTH_CHECK_TTL_MS (30s) or after a
   * failed operation. This eliminates ~5ms per tool call.
   */
  async ensureAlive(): Promise<void> {
    const isOpen = this.ws?.readyState === WebSocket.OPEN;
    if (!isOpen || !this._sessionId) {
      await this.stop();
      await this.start();
      return;
    }

    // Fast path: if recent health check passed and no failures, skip CDP roundtrip
    const now = Date.now();
    if (!this._lastOperationFailed && (now - this._lastHealthCheck) < this.HEALTH_CHECK_TTL_MS) {
      return;
    }

    // Full health check with two-stage probe (as before)
    try {
      await this.sendRawCdp("Target.getTargets", {}, null, 2_000);
      this._lastHealthCheck = now;
      this._lastOperationFailed = false;
      return;
    } catch {
      // probe 1 failed — could be transient, could be consent-pending
    }
    try {
      await this.sendRawCdp("Target.getTargets", {}, null);
      this._lastHealthCheck = now;
      this._lastOperationFailed = false;
      return;
    } catch {
      // genuinely stale — fall through to reconnect
    }

    await this.stop();
    await this.start();
  }

  // ── CDP Communication ────────────────────────────────────────────────────

  /**
   * Send a CDP method and return the result.
   * Handles session management — Target.* methods skip session,
   * others use explicit sessionId or the daemon's default session.
   */
  async cdp(
    method: string,
    params?: Record<string, unknown>,
    sessionId?: string | null,
  ): Promise<unknown> {
    // Browser-level Target.* calls must NOT use a session.
    // Everything else uses the explicit sessionId (any session attached
    // with flatten:true on this connection is reachable via the top-level
    // sessionId field — that's what flat-protocol mode means).
    const effectiveSid = method.startsWith("Target.") ? null : (sessionId ?? this._sessionId);

    try {
      const result = await this.sendRawCdp(method, params ?? {}, effectiveSid);
      this._lastOperationFailed = false;
      return result;
    } catch (err) {
      this._lastOperationFailed = true;
      // Auto-recover from stale default session — retry once
      if (err instanceof SessionNotFoundError && effectiveSid === this._sessionId) {
        await this.attachFirstPage();
        return this.sendRawCdp(method, params ?? {}, this._sessionId);
      }
      throw err;
    }
  }

  // ── High-level Browser Helpers ────────────────────────────────────────────

  /** Get page state or dialog info. Uses short-lived cache to eliminate redundant evaluateJS calls. */
  async getPageInfo(): Promise<PageInfoResult> {
    // Check for buffered dialog first
    if (this._currentDialog) {
      const dialog = this._currentDialog;
      this._currentDialog = null; // consume it
      return { dialog };
    }

    // Return cached page info if still fresh (eliminates redundant CDP roundtrips)
    const now = Date.now();
    if (this._cachedPageInfo && (now - this._cachedPageInfoTime) < this.PAGE_INFO_TTL_MS) {
      return this._cachedPageInfo;
    }

    const js = `JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})`;
    const raw = await this.evaluateJS(js);
    const info = JSON.parse(raw as string) as PageInfo;

    // Cache for subsequent calls
    this._cachedPageInfo = info;
    this._cachedPageInfoTime = now;
    return info;
  }

  /** Invalidate page info cache (call after navigation). */
  invalidatePageInfoCache(): void {
    this._cachedPageInfo = null;
    this._cachedPageInfoTime = 0;
  }

  /** Mark last operation as failed so ensureAlive re-checks health next time. */
  markOperationFailed(): void {
    this._lastOperationFailed = true;
  }

  /**
   * Capture a screenshot and write to disk.
   *
   * OPTIMIZED: Supports JPEG with configurable quality for faster CDP transfer.
   * JPEG q80 is 2-5x smaller than PNG for photo-heavy pages with negligible quality loss,
   * which speeds up both the CDP transfer and the LLM reading the image.
   */
  async captureScreenshot(
    outputPath: string,
    fullPage = false,
    format: "png" | "jpeg" = "png",
    quality = 80,
  ): Promise<string> {
    const params: Record<string, unknown> = {
      format,
      captureBeyondViewport: fullPage,
    };
    if (format === "jpeg") {
      params.quality = quality;
    }
    const result = (await this.cdp("Page.captureScreenshot", params)) as { data: string };

    const buf = Buffer.from(result.data, "base64");
    await writeFile(outputPath, buf);
    return outputPath;
  }

  /**
   * Wait for page load using CDP events instead of polling.
   * Dramatically faster than polling readyState every 300ms — especially
   * for pages that are already loaded (detected instantly via events).
   */
  async waitForLoad(timeoutMs = 15_000): Promise<boolean> {
    // Fast path: check if already loaded
    try {
      const state = await this.evaluateJS("document.readyState");
      if (state === "complete") return true;
    } catch {
      // proceed to event-based wait
    }

    // Drain any buffered events from before we started waiting
    await this.drainEvents();

    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const events = await this.drainEvents();
      for (const ev of events) {
        if (ev.method === "Page.loadEventFired") return true;
        if (ev.method === "Page.frameStoppedLoading") {
          // Frame stopped — verify readyState
          try {
            const state = await this.evaluateJS("document.readyState");
            if (state === "complete") return true;
          } catch {
            // keep waiting
          }
        }
      }
      // Short sleep between event drain cycles (50ms vs 300ms baseline)
      await new Promise((r) => setTimeout(r, 50));
    }

    // Timeout fallback: final readyState check
    try {
      const state = await this.evaluateJS("document.readyState");
      return state === "complete";
    } catch {
      return false;
    }
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

  /** Get current tab info — uses the targetId we attached to. */
  async currentTab(): Promise<TabInfo> {
    if (!this._targetId) {
      throw new Error("No tab attached. Call newTab/switchTab first.");
    }
    const result = (await this.cdp("Target.getTargetInfo", {
      targetId: this._targetId,
    })) as {
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
    this.invalidatePageInfoCache();
    if (url && url !== "about:blank") {
      await this.cdp("Page.navigate", { url });
      this.invalidatePageInfoCache();
    }
    return result.targetId;
  }

  /**
   * Activate and attach to a tab.
   *
   * OPTIMIZED: Enables core domains in parallel (Promise.all) instead of
   * sequential await. Reduces tab-switch latency by ~30%.
   */
  async switchTab(targetId: string): Promise<void> {
    await this.cdp("Target.activateTarget", { targetId });
    const result = (await this.cdp("Target.attachToTarget", {
      targetId,
      flatten: true,
    })) as { sessionId: string };

    this._sessionId = result.sessionId;
    this._targetId = targetId;
    this.invalidatePageInfoCache();

    // Enable core domains in parallel (pipelined over single WS connection)
    await Promise.all(
      ["Page", "DOM", "Runtime", "Network"].map((domain) =>
        this.cdp(`${domain}.enable`).catch(() => {})
      )
    );

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

    const sid = targetId || null;
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

  /** Drain buffered CDP events from the internal buffer */
  async drainEvents(): Promise<CDPEvent[]> {
    const events = this._eventBuffer;
    this._eventBuffer = [];
    return events;
  }

  /** Get virtual key code for a key name or character */
  getVirtualKeyCode(key: string): number {
    return VIRTUAL_KEY_CODES[key] ?? (key.length === 1 ? key.charCodeAt(0) : 0);
  }

  /** Get the key code string for CDP */
  getKeyCode(key: string): string {
    return key.length === 1 && !VIRTUAL_KEY_CODES[key] ? key : key;
  }

  // ── Internal: WebSocket Connection ────────────────────────────────────────

  private async connect(): Promise<void> {
    const timeoutMs = CDP_CONNECT_TIMEOUT_MS;
    const wsUrl = this.remote?.cdpUrl
      ? this.remote.cdpUrl
      : process.env.BU_CDP_WS
        ? process.env.BU_CDP_WS
        : await discoverWsUrl();

    if (!this.remote) {
      this.remote = {
        cdpUrl: wsUrl,
        browserId: wsUrl.split("/").pop() || "unknown",
      };
    }

    await this.openWebSocket(wsUrl, timeoutMs);
    await this.attachFirstPage();
  }

  private openWebSocket(url: string, timeoutMs: number): Promise<void> {
    return new Promise((resolve, reject) => {
      this._connectResolve = resolve;
      this._connectReject = reject;

      this._connectTimer = setTimeout(() => {
        this._connectTimer = null;
        this._connectReject = null;
        if (this.ws) {
          try { this.ws.close(); } catch { /* ignore */ }
          this.ws = null;
        }
        reject(new Error(`CDP WebSocket connection timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      try {
        this.ws = new WebSocket(url);
      } catch (err) {
        clearTimeout(this._connectTimer!);
        this._connectTimer = null;
        reject(err);
        return;
      }

      this.ws.onopen = () => {
        if (this._connectTimer) {
          clearTimeout(this._connectTimer);
          this._connectTimer = null;
        }
        this._connectResolve = null;
        this._connectReject = null;
        // NOTE: do not clear _reconnectAttempts here. Chrome accepts the
        // WS upgrade before the user clicks Allow on the remote-debugging
        // consent dialog, so a successful onopen does not prove the
        // connection is usable. We only consider the connection healthy
        // once a CDP roundtrip completes — see attachFirstPage.
        resolve();
      };

      this.ws.onmessage = (event: WebSocket.MessageEvent) => {
        const data = event.data;
        this.handleMessage(typeof data === "string" ? data : data.toString());
      };

      this.ws.onerror = (_event: WebSocket.ErrorEvent) => {
        // Only reject during the connect phase; otherwise it means a disconnect
        if (this._connectReject) {
          const err = new Error("CDP WebSocket error during connection");
          this._connectReject(err);
          this._connectReject = null;
          if (this._connectTimer) {
            clearTimeout(this._connectTimer);
            this._connectTimer = null;
          }
        }
      };

      this.ws.onclose = (_event: WebSocket.CloseEvent) => {
        // If we're shutting down intentionally, don't reconnect
        if (this._stopping) return;

        // If we never saw a successful CDP roundtrip on this connection,
        // the close almost certainly means the user denied (or hasn't yet
        // accepted) Chrome's "Allow remote debugging?" prompt. Reconnecting
        // would just spawn another popup. Bail out and let the next tool
        // call surface a clear error.
        if (!this._consentObserved) {
          this._sessionId = null;
          return;
        }

        // Auto-reconnect with backoff
        if (this._reconnectAttempts < CDP_MAX_RECONNECT_ATTEMPTS) {
          this._sessionId = null;
          // Reset for the new connection — it must re-prove itself.
          this._consentObserved = false;
          const delay = Math.min(
            CDP_RECONNECT_BASE_MS * 2 ** this._reconnectAttempts,
            15_000,
          );
          this._reconnectAttempts++;
          setTimeout(() => {
            if (!this._stopping) {
              this.start().catch(() => {
                // Reconnection ultimately failed — tools will report errors
              });
            }
          }, delay);
        }
      };
    });
  }

  // ── Internal: Message Handling ────────────────────────────────────────────

  private handleMessage(data: string): void {
    let msg: CDPMessage;
    try {
      msg = JSON.parse(data);
    } catch {
      return; // Corrupt frame, ignore
    }

    // CDP events have no `id` — they have a `method` field
    if (msg.id === undefined) {
      // Dialog detection
      if (msg.method === "Page.javascriptDialogOpening") {
        this._currentDialog = {
          type: (msg.params?.type as DialogInfo["type"]) || "alert",
          message: (msg.params?.message as string) || "",
          defaultPrompt: msg.params?.defaultPrompt as string | undefined,
        };
        return;
      }

      // Dialog closed — clear the stored dialog
      if (msg.method === "Page.javascriptDialogClosed") {
        this._currentDialog = null;
        return;
      }

      // Buffer other events for drainEvents()
      this._eventBuffer.push({
        method: msg.method!,
        params: msg.params as unknown,
        session_id: msg.sessionId as string | undefined,
      });
      return;
    }

    // It's a response to a pending request
    const pending = this._pending.get(msg.id);
    if (!pending) return; // Stale response, ignore

    this._pending.delete(msg.id);
    clearTimeout(pending.timer);

    if (msg.error) {
      // Handle stale session recovery
      const errMsg = msg.error.message || String(msg.error);
      if (
        errMsg.includes("Session with given id not found") &&
        pending.sessionId === this._sessionId
      ) {
        // Schedule recovery and reject — caller can retry
        pending.reject(new SessionNotFoundError(errMsg));
        return;
      }
      pending.reject(new Error(`CDP error (${pending.method}): ${errMsg}`));
      return;
    }

    pending.resolve(msg.result);
  }

  /** Send a CDP command directly to the browser session */
  private sendRawCdp(
    method: string,
    params: Record<string, unknown>,
    sessionId: string | null,
    timeoutMs: number = CDP_REQUEST_TIMEOUT_MS,
  ): Promise<unknown> {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("Browser not connected. Is Chrome running?"));
    }

    const id = this._nextId++;
    const payload: Record<string, unknown> = { id, method, params };
    if (sessionId) payload.sessionId = sessionId;
    const msg = JSON.stringify(payload);

    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this._pending.delete(id);
        reject(new Error(`CDP timeout after ${timeoutMs}ms: ${method}`));
      }, timeoutMs);

      this._pending.set(id, { resolve, reject, timer, method, sessionId });
      try {
        this.ws!.send(msg);
      } catch (err) {
        clearTimeout(timer);
        this._pending.delete(id);
        reject(err);
      }
    });
  }

  /** Attach to the first real page target. Creates about:blank if none exist. */
  private async attachFirstPage(): Promise<string> {
    const result = (await this.sendRawCdp("Target.getTargets", {}, null)) as {
      targetInfos: Array<{ targetId: string; type: string; url: string }>;
    };

    // First CDP roundtrip succeeded — consent has been granted. Only now
    // is it safe to reset the reconnect counter; otherwise a ws that opens
    // but is silently held by Chrome's consent dialog would let us loop
    // forever stacking popups on top of each other.
    this._consentObserved = true;
    this._reconnectAttempts = 0;

    const pages = result.targetInfos.filter(
      (t) => t.type === "page" && !isInternalUrl(t.url),
    );

    if (pages.length === 0) {
      const created = (await this.sendRawCdp(
        "Target.createTarget",
        { url: "about:blank" },
        null,
      )) as { targetId: string };
      pages.push({ targetId: created.targetId, type: "page", url: "about:blank" });
    }

    const attachResult = (await this.sendRawCdp(
      "Target.attachToTarget",
      { targetId: pages[0].targetId, flatten: true },
      null,
    )) as { sessionId: string };

    this._sessionId = attachResult.sessionId;
    this._targetId = pages[0].targetId;

    // Enable core domains
    for (const domain of ["Page", "DOM", "Runtime", "Network"]) {
      try {
        await this.sendRawCdp(`${domain}.enable`, {}, this._sessionId);
      } catch {
        // best-effort
      }
    }

    // Mark tab
    try {
      await this.sendRawCdp(
        "Runtime.evaluate",
        {
          expression: `if(!document.title.startsWith('🟢'))document.title='🟢 '+document.title`,
        },
        this._sessionId,
      );
    } catch {
      // best-effort
    }

    this._lastHealthCheck = Date.now();
    this._lastOperationFailed = false;
    return attachResult.sessionId;
  }

  /** Auto-recover from a stale session error by re-attaching */
  async recoverSession(): Promise<void> {
    await this.attachFirstPage();
  }

  // ── Error diagnostics ────────────────────────────────────────────────────

  private needsChromeSetup(errorMsg: string): boolean {
    const lower = errorMsg.toLowerCase();
    return (
      lower.includes("devtoolsactiveport") ||
      lower.includes("cannot reach chrome") ||
      lower.includes("ecode") && lower.includes("econnrefused") ||
      (lower.includes("ws handshake") &&
        (lower.includes("403") || lower.includes("timed out")))
    );
  }
}

// ── Internal Types ───────────────────────────────────────────────────────────

interface PendingRequest {
  resolve: (value: unknown) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
  method: string;
  sessionId: string | null;
}

interface CDPMessage {
  id?: number;
  method?: string;
  params?: Record<string, unknown>;
  result?: unknown;
  error?: { message: string; code?: number };
  sessionId?: string;
}

// ── Error Classes ────────────────────────────────────────────────────────────

class SessionNotFoundError extends Error {
  constructor(msg: string) {
    super(msg);
    this.name = "SessionNotFoundError";
  }
}
