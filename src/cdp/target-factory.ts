/**
 * The single place harness tabs and windows are created.
 *
 * Every tab the harness opens must land in the pinned profile, so all creation
 * paths (client.newTab, browser_open_urls, isolated tabs for web_search /
 * read_page) funnel through here. A missed call site would silently act in
 * another profile — with that profile's cookies and logins.
 *
 * Two mechanisms, chosen by whether a profile is pinned:
 *
 *   unpinned — `Target.createTarget`, exactly as before: `newWindow: true` for
 *              a fresh dedicated window, `openerId` for siblings inside it.
 *
 *   pinned   — the window comes from a command-line launch into the profile
 *              (see profile/launch.ts), and further tabs come from
 *              `window.open(..., '_blank')` evaluated in an owned page with
 *              `userGesture: true`. That is the only CDP-reachable way to place
 *              a tab in a non-default browser context: createTarget rejects a
 *              foreign browserContextId outright, and `openerId` does NOT
 *              inherit the opener's context (verified — it lands in the
 *              focus-derived default context, in a different window).
 *              window.open keeps both the context and the window, recursively.
 *
 * Correlation: window.open returns no target id, so each spawn carries a unique
 * `about:blank#pi-<uuid>` token and the new target is found by that token.
 * Set-difference polling would be wrong here — isolated tabs run concurrently
 * (browser_read_page is registered unserialized).
 */

import { randomUUID } from "node:crypto";
import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import { attachTo } from "./attach";
import { type CdpError, cdpError } from "./errors";
import { getWindowId } from "./window";

/** How long to wait for a window.open-spawned target to appear. */
const SPAWN_DEADLINE_MS = 8_000;
const SPAWN_POLL_MS = 100;

export type HarnessWindow = {
  /** Target id of the window's seed tab. */
  readonly targetId: string;
  /**
   * True when this call created the window. The seed tab is then a blank tab
   * the caller may use directly, instead of opening a second one.
   */
  readonly freshlyCreated: boolean;
};

type PageTarget = {
  readonly targetId: string;
  readonly type: string;
  readonly url: string;
  readonly browserContextId?: string;
};

const listPageTargets = async (client: BrowserClient): Promise<Result<ReadonlyArray<PageTarget>, CdpError>> => {
  const r = await client.session().callBrowser("Target.getTargets");
  if (!r.success) return r;
  return ok(r.data.targetInfos.filter((t) => t.type === "page"));
};

/** A CDP session id for driving `targetId`, reusing the active one when possible. */
const sessionForTarget = async (client: BrowserClient, targetId: string): Promise<Result<string, CdpError>> => {
  const current = client.current();
  if (current?.targetId === targetId) return ok(current.sessionId);
  return attachTo(client.session(), targetId);
};

/**
 * Spawn a tab from `openerTargetId` via window.open, so it inherits the
 * opener's profile and window, and return its target id.
 */
const spawnTabViaOpener = async (
  client: BrowserClient,
  openerTargetId: string,
): Promise<Result<string, CdpError>> => {
  const session = await sessionForTarget(client, openerTargetId);
  if (!session.success) return session;

  const token = `pi-${randomUUID()}`;
  // userGesture: true is what gets this past the popup blocker.
  const opened = await client.session().callOnTarget(
    "Runtime.evaluate",
    {
      expression: `!!window.open('about:blank#${token}', '_blank')`,
      returnByValue: true,
      userGesture: true,
    },
    session.data,
  );
  if (!opened.success) return opened;
  if (opened.data.result.value !== true) {
    return err(cdpError(
      "invalid_response",
      "the browser blocked window.open in the pinned profile's window — the page may have navigated away; retry, or run /browser-profile to re-seed",
      "Runtime.evaluate",
    ));
  }

  const deadline = Date.now() + SPAWN_DEADLINE_MS;
  while (Date.now() < deadline) {
    const targets = await listPageTargets(client);
    if (targets.success) {
      const spawned = targets.data.find((t) => t.url.includes(token));
      if (spawned) return ok(spawned.targetId);
    }
    await new Promise((r) => setTimeout(r, SPAWN_POLL_MS));
  }
  return err(cdpError("timeout", `the tab opened in the pinned profile did not report back within ${SPAWN_DEADLINE_MS}ms`));
};

/**
 * In-flight window creation, per client. Isolated tabs run concurrently
 * (browser_read_page is registered unserialized), so two of them starting at
 * once would otherwise each find "no harness window" and create one — two blank
 * windows before, and two launched profile windows now. Callers share the first
 * call's result instead.
 */
const inFlight = new WeakMap<BrowserClient, Promise<Result<HarnessWindow, CdpError>>>();

/**
 * The harness window for this session, creating it when absent.
 *
 * Reuses a live owned tab when one exists — including after the user closed the
 * original seed — so reconnects don't scatter windows.
 */
export const ensureHarnessWindow = async (client: BrowserClient): Promise<Result<HarnessWindow, CdpError>> => {
  const pending = inFlight.get(client);
  if (pending) {
    const shared = await pending;
    // `freshlyCreated` is a claim on the seed tab, and only the caller that
    // started the creation may hold it. Everyone waiting on the same window
    // must open a tab of their own beside it, or two callers would drive the
    // very same tab.
    return shared.success ? ok({ targetId: shared.data.targetId, freshlyCreated: false }) : shared;
  }
  const attempt = ensureHarnessWindowUncoordinated(client).finally(() => inFlight.delete(client));
  inFlight.set(client, attempt);
  return attempt;
};

const ensureHarnessWindowUncoordinated = async (
  client: BrowserClient,
): Promise<Result<HarnessWindow, CdpError>> => {
  const targets = await listPageTargets(client);
  if (!targets.success) return targets;
  const live = new Set(targets.data.map((t) => t.targetId));

  const ownership = client.ownership();
  const pinnedCtx = client.profileContextId();
  // A tab may only be reused when we can prove which profile it is in. With a
  // pin set but no context resolved yet — a fresh connection, or a browser that
  // restarted — the recorded tabs cannot be verified, so we seed a new window
  // rather than risk adopting one from the wrong profile. (Sessions close their
  // owned tabs on shutdown, so this is the normal, no-cost case.)
  const canReuse = client.profilePin() === null || pinnedCtx !== undefined;
  const inPinnedProfile = (targetId: string): boolean => {
    if (!pinnedCtx) return true;
    const info = targets.data.find((t) => t.targetId === targetId);
    return info?.browserContextId === pinnedCtx;
  };

  if (canReuse) {
    const harnessWindow = ownership.harnessWindow();
    if (harnessWindow && live.has(harnessWindow) && inPinnedProfile(harnessWindow)) {
      return ok({ targetId: harnessWindow, freshlyCreated: false });
    }
    const survivor = ownership.list().find((id) => live.has(id) && inPinnedProfile(id));
    if (survivor) {
      ownership.setHarnessWindow(survivor);
      return ok({ targetId: survivor, freshlyCreated: false });
    }
  }

  const seeded = client.profilePin()
    ? await client.seedPinnedProfileWindow()
    : await createDedicatedWindow(client);
  if (!seeded.success) return seeded;
  return ok({ targetId: seeded.data, freshlyCreated: true });
};

/** Unpinned path: a fresh dedicated window, exactly as the harness always did. */
const createDedicatedWindow = async (client: BrowserClient): Promise<Result<string, CdpError>> => {
  const created = await client.session().callBrowser("Target.createTarget", { url: "about:blank", newWindow: true });
  if (!created.success) return created;
  const { targetId } = created.data;
  const ownership = client.ownership();
  ownership.setHarnessWindow(targetId);
  ownership.add(targetId);
  const win = await getWindowId(client.session(), targetId);
  if (win.success) ownership.setHarnessWindowId(win.data);
  return ok(targetId);
};

/**
 * Open a harness-owned tab beside `openerTargetId`, in the same window and —
 * when a profile is pinned — the same profile. The tab is registered as owned.
 */
export const openHarnessTab = async (
  client: BrowserClient,
  openerTargetId: string,
): Promise<Result<string, CdpError>> => {
  const spawned = client.profileContextId()
    ? await spawnTabViaOpener(client, openerTargetId)
    : await (async (): Promise<Result<string, CdpError>> => {
        const created = await client.session().callBrowser("Target.createTarget", {
          url: "about:blank",
          openerId: openerTargetId,
        });
        if (!created.success) return created;
        return ok(created.data.targetId);
      })();
  if (!spawned.success) return spawned;
  client.ownership().add(spawned.data);
  return ok(spawned.data);
};
