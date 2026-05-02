import { type Result, err, ok } from "./util/result";
import { safeJs } from "./util/js-template";
import { discoverWsUrl } from "./cdp/discovery";
import { type CdpError, cdpError } from "./cdp/errors";
import type { CdpTransport } from "./cdp/transport";
import { createCdpTransport } from "./cdp/transport";
import { type CdpSession, createCdpSession } from "./cdp/session";
import type { DaemonStatus, DialogInfo, PageInfo, TabInfo } from "./cdp/types";

export type BrowserClientOptions = {
  readonly namespace: string;
  readonly remote?: { readonly cdpUrl: string; readonly browserId: string };
};

export type BrowserClient = {
  readonly namespace: string;
  ensureAlive(): Promise<Result<void, CdpError>>;
  status(): DaemonStatus;
  start(): Promise<Result<void, CdpError>>;
  stop(): Promise<void>;
  evaluateJs(expression: string, sessionId?: string): Promise<Result<unknown, CdpError>>;
  pageInfo(): Promise<Result<PageInfo | { readonly dialog: DialogInfo }, CdpError>>;
  takeDialog(): DialogInfo | null;
  listTabs(includeInternal?: boolean): Promise<Result<ReadonlyArray<TabInfo>, CdpError>>;
  switchTab(targetId: string): Promise<Result<void, CdpError>>;
  newTab(url?: string): Promise<Result<string, CdpError>>;
  current(): { readonly sessionId: string; readonly targetId: string } | null;
  session(): CdpSession;
  transport(): CdpTransport;
};

const HEALTH_TTL_MS = 30_000;
const PAGE_INFO_TTL_MS = 1_000;

const parsePageInfoPayload = (v: unknown): Result<PageInfo, CdpError> => {
  if (typeof v !== "object" || v === null) {
    return err(cdpError("invalid_response", "page info payload is not an object"));
  }
  const o = v as Readonly<Record<string, unknown>>;
  const fields: ReadonlyArray<readonly [string, "string" | "number"]> = [
    ["url", "string"], ["title", "string"],
    ["w", "number"], ["h", "number"],
    ["sx", "number"], ["sy", "number"],
    ["pw", "number"], ["ph", "number"],
  ];
  for (const [k, t] of fields) {
    if (typeof o[k] !== t) {
      return err(cdpError("invalid_response", `page info field ${k} has wrong type (expected ${t})`));
    }
  }
  return ok({
    url: o["url"] as string,
    title: o["title"] as string,
    width: o["w"] as number,
    height: o["h"] as number,
    scrollX: o["sx"] as number,
    scrollY: o["sy"] as number,
    pageWidth: o["pw"] as number,
    pageHeight: o["ph"] as number,
  });
};

export const createBrowserClient = (opts: BrowserClientOptions): BrowserClient => {
  const transport = createCdpTransport();
  const session = createCdpSession(transport);
  let lastHealth = 0;
  let pageCache: { readonly info: PageInfo; readonly at: number } | null = null;
  let remote: BrowserClientOptions["remote"] | null = opts.remote ?? null;

  const start = async (): Promise<Result<void, CdpError>> => {
    if (transport.state() === "open" && session.current()) return ok(undefined);
    const envUrl = process.env["BU_CDP_WS"];
    let wsUrl: string;
    if (remote?.cdpUrl) {
      wsUrl = remote.cdpUrl;
    } else if (envUrl) {
      wsUrl = envUrl;
    } else {
      const discovered = await discoverWsUrl();
      if (!discovered.success) return discovered;
      wsUrl = discovered.data;
    }
    const connected = await transport.connect(wsUrl, { timeoutMs: 10_000 });
    if (!connected.success) return connected;
    if (!remote) {
      remote = { cdpUrl: wsUrl, browserId: wsUrl.split("/").pop() ?? "unknown" };
    }
    const attached = await session.attachFirstPage();
    if (!attached.success) {
      await transport.close();
      return attached;
    }
    lastHealth = Date.now();
    pageCache = null;
    return ok(undefined);
  };

  const stop = async (): Promise<void> => {
    await transport.close();
    pageCache = null;
    lastHealth = 0;
  };

  const ensureAlive = async (): Promise<Result<void, CdpError>> => {
    if (transport.state() !== "open" || !session.current()) {
      await stop();
      return start();
    }
    if (Date.now() - lastHealth < HEALTH_TTL_MS) return ok(undefined);
    const probe = await transport.request("Target.getTargets", {}, { sessionId: null, timeoutMs: 2_000 });
    if (probe.success) {
      lastHealth = Date.now();
      return ok(undefined);
    }
    await stop();
    return start();
  };

  const evaluateJs = async (expression: string, sessionId?: string): Promise<Result<unknown, CdpError>> => {
    const wrapped = expression.includes("return ") && !expression.trim().startsWith("(")
      ? `(function(){${expression}})()`
      : expression;
    const r = sessionId
      ? await session.callOnTarget("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true }, sessionId)
      : await session.call("Runtime.evaluate", { expression: wrapped, returnByValue: true, awaitPromise: true });
    if (!r.success) return r;
    const data = r.data as { result?: { value?: unknown }; exceptionDetails?: unknown };
    if (data.exceptionDetails) {
      return err(cdpError("remote_error", `JS evaluation failed: ${JSON.stringify(data.exceptionDetails)}`, "Runtime.evaluate"));
    }
    return ok(data.result?.value);
  };

  const readPageInfo = async (): Promise<Result<PageInfo, CdpError>> => {
    const dirty = session.drainPageInfoInvalidations();
    if (pageCache && !dirty && Date.now() - pageCache.at < PAGE_INFO_TTL_MS) return ok(pageCache.info);
    const expr = safeJs`JSON.stringify({url:location.href,title:document.title,w:innerWidth,h:innerHeight,sx:scrollX,sy:scrollY,pw:document.documentElement.scrollWidth,ph:document.documentElement.scrollHeight})`;
    const raw = await evaluateJs(expr);
    if (!raw.success) return raw;
    if (typeof raw.data !== "string") return err(cdpError("invalid_response", "page info evaluation did not return a string"));
    let parsedRaw: unknown;
    try {
      parsedRaw = JSON.parse(raw.data);
    } catch (e) {
      return err(cdpError("invalid_response", `page info JSON.parse failed: ${e instanceof Error ? e.message : String(e)}`));
    }
    const info = parsePageInfoPayload(parsedRaw);
    if (!info.success) return info;
    pageCache = { info: info.data, at: Date.now() };
    return ok(info.data);
  };

  const pageInfo = async (): Promise<Result<PageInfo | { readonly dialog: DialogInfo }, CdpError>> => {
    const d = session.takeDialog();
    if (d) return ok({ dialog: d });
    return readPageInfo();
  };

  const listTabs = async (includeInternal = true): Promise<Result<ReadonlyArray<TabInfo>, CdpError>> => {
    const r = await session.callBrowser("Target.getTargets");
    if (!r.success) return r;
    const data = r.data as { targetInfos: ReadonlyArray<{ targetId: string; type: string; title: string; url: string }> };
    const tabs = data.targetInfos
      .filter((t) => t.type === "page")
      .filter((t) => includeInternal || !t.url.startsWith("chrome://"))
      .map((t): TabInfo => ({ targetId: t.targetId, title: t.title, url: t.url }));
    return ok(tabs);
  };

  const switchTab = async (targetId: string): Promise<Result<void, CdpError>> => {
    const r = await session.switchTo(targetId);
    if (!r.success) return r;
    pageCache = null;
    // Best-effort: mark the tab title with a green circle so the user can
    // see which tab the agent attached to. CSP or detached frames may
    // block the eval; we don't surface that as a switchTab failure.
    await session.call("Runtime.evaluate", {
      expression: safeJs`if(!document.title.startsWith('🟢'))document.title='🟢 '+document.title`,
    });
    return ok(undefined);
  };

  const newTab = async (url?: string): Promise<Result<string, CdpError>> => {
    const created = await session.callBrowser("Target.createTarget", { url: "about:blank" });
    if (!created.success) return created;
    const c = created.data as { targetId: string };
    const switched = await switchTab(c.targetId);
    if (!switched.success) return switched;
    if (url && url !== "about:blank") {
      const nav = await session.call("Page.navigate", { url });
      if (!nav.success) return nav;
      pageCache = null;
    }
    return ok(c.targetId);
  };

  const status = (): DaemonStatus => ({
    alive: transport.state() === "open" && session.current() !== null,
    sessionId: session.current()?.sessionId ?? null,
    namespace: opts.namespace,
    ...(remote?.browserId !== undefined ? { remoteBrowserId: remote.browserId } : {}),
  });

  return {
    namespace: opts.namespace,
    ensureAlive, status, start, stop,
    evaluateJs, pageInfo,
    takeDialog: () => session.takeDialog(),
    listTabs, switchTab, newTab,
    current: () => session.current(),
    session: () => session,
    transport: () => transport,
  };
};
