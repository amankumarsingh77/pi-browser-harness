// `window.open` with userGesture is the only CDP-reachable way into a non-default browser context: createTarget rejects a foreign browserContextId and `openerId` does not inherit the opener's context.

import { randomUUID } from "node:crypto";
import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import { type CdpError, cdpError } from "./errors";

const SPAWN_DEADLINE_MS = 8_000;
const SPAWN_POLL_MS = 100;

export type HarnessWindow = {
  readonly targetId: string;
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

const sessionForTarget = async (client: BrowserClient, targetId: string): Promise<Result<string, CdpError>> => {
  const current = client.current();
  if (current?.targetId === targetId) return ok(current.sessionId);
  return client.session().attach(targetId);
};

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

const inFlight = new WeakMap<BrowserClient, Promise<Result<HarnessWindow, CdpError>>>();

export const ensureHarnessWindow = async (client: BrowserClient): Promise<Result<HarnessWindow, CdpError>> => {
  const pending = inFlight.get(client);
  if (pending) {
    const shared = await pending;
    // `freshlyCreated` is a claim on the seed tab that only the caller which started the creation may hold, or two callers would drive the same tab.
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
  // With a pin set but no context resolved yet, a recorded tab's profile cannot be verified, so seed a new window rather than risk adopting one from the wrong profile.
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

const createDedicatedWindow = async (client: BrowserClient): Promise<Result<string, CdpError>> => {
  const created = await client.session().callBrowser("Target.createTarget", { url: "about:blank", newWindow: true });
  if (!created.success) return created;
  const { targetId } = created.data;
  const ownership = client.ownership();
  ownership.setHarnessWindow(targetId);
  ownership.add(targetId);
  const win = await client.session().windowId(targetId);
  if (win.success) ownership.setHarnessWindowId(win.data);
  return ok(targetId);
};

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
