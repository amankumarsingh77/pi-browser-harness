/**
 * Unit test (mock transport) for window-scoped session binding + tab teardown.
 *
 * Covers the two fixes:
 *  1. The session binds to a real Chrome windowId. New tabs land in that window;
 *     tabs opened by an owned page (popups / window.open) are auto-adopted so the
 *     session controls them; nothing outside the window is ever owned.
 *  2. closeOwnedTabs() closes every owned tab and clears the window binding — the
 *     teardown the extension runs on session shutdown so no stale tabs survive.
 *
 * Run: npx tsx test/manual/window-binding-test.ts
 */
import { createBrowserClient } from "../../src/client";
import { createOwnershipRegistry } from "../../src/cdp/ownership";
import type { CdpTransport } from "../../src/cdp/transport";
import type { CdpEvent } from "../../src/cdp/types";
import { ok, type Result } from "../../src/util/result";
import type { CdpError } from "../../src/cdp/errors";

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string): void => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
};

// ── A minimal in-memory CDP browser the mock transport drives. ──────────────
type FakeTarget = { targetId: string; type: string; url: string; title: string; windowId: number; openerId?: string };

const createMockTransport = (): CdpTransport & {
  seed: (t: FakeTarget) => void;
  targets: Map<string, FakeTarget>;
  closed: ReadonlyArray<string>;
} => {
  const targets = new Map<string, FakeTarget>();
  const closed: string[] = [];
  let sessionSeq = 0;
  let targetSeq = 0;
  let windowSeq = 100;

  // Event queue plumbing so session.ts's consumeEvents() can await targetCreated.
  const listeners: Array<() => void> = [];
  let buffer: CdpEvent[] = [];
  let waiter: (() => void) | null = null;
  const push = (ev: CdpEvent): void => {
    buffer.push(ev);
    if (waiter) { const w = waiter; waiter = null; w(); }
  };
  const iterable: AsyncIterable<CdpEvent> = {
    [Symbol.asyncIterator]() {
      return {
        async next(): Promise<IteratorResult<CdpEvent>> {
          if (buffer.length === 0) {
            await new Promise<void>((r) => { waiter = r; });
          }
          const v = buffer.shift()!;
          return { value: v, done: false };
        },
      };
    },
  };

  const request = async (
    method: string,
    params: Record<string, unknown>,
  ): Promise<Result<unknown, CdpError>> => {
    switch (method) {
      case "Target.setDiscoverTargets":
      case "Page.enable": case "DOM.enable": case "Runtime.enable":
      case "Network.enable": case "Accessibility.enable": case "Log.enable":
      case "Target.activateTarget":
        return ok({});
      case "Target.getTargets":
        return ok({ targetInfos: [...targets.values()].map((t) => ({ targetId: t.targetId, type: t.type, url: t.url, title: t.title })) });
      case "Browser.getWindowForTarget": {
        const t = targets.get(params["targetId"] as string);
        return ok({ windowId: t?.windowId ?? -1, bounds: {} });
      }
      case "Target.createTarget": {
        const id = `tgt-${++targetSeq}`;
        const opener = params["openerId"] as string | undefined;
        const newWindow = params["newWindow"] === true;
        const windowId = newWindow || !opener ? ++windowSeq : (targets.get(opener)?.windowId ?? ++windowSeq);
        const t: FakeTarget = { targetId: id, type: "page", url: (params["url"] as string) ?? "about:blank", title: "", windowId, ...(opener ? { openerId: opener } : {}) };
        targets.set(id, t);
        // Chrome fires targetCreated for every new target (discover:true).
        push({ method: "Target.targetCreated", params: { targetInfo: { targetId: id, type: "page", url: t.url, openerId: opener } } });
        return ok({ targetId: id });
      }
      case "Target.attachToTarget":
        return ok({ sessionId: `sess-${++sessionSeq}` });
      case "Target.detachFromTarget":
        return ok({});
      case "Target.closeTarget": {
        const id = params["targetId"] as string;
        if (targets.delete(id)) { closed.push(id); push({ method: "Target.targetDestroyed", params: { targetId: id } }); }
        return ok({});
      }
      case "Runtime.evaluate":
        return ok({ result: { value: "complete" } });
      case "Page.navigate":
        return ok({ frameId: "f1" });
      default:
        return ok({});
    }
  };

  return {
    connect: async () => ok(undefined),
    close: async () => { for (const l of listeners) l(); },
    request,
    events: () => iterable,
    state: () => "open",
    onClose: (cb) => { listeners.push(cb); return () => {}; },
    seed: (t) => targets.set(t.targetId, t),
    targets,
    get closed() { return closed; },
  };
};

const tick = (): Promise<void> => new Promise((r) => setTimeout(r, 20));

async function main(): Promise<void> {
  console.log("window-binding-test\n");

  // ── Registry: windowId binding is stored + cleared. ───────────────────────
  {
    const reg = createOwnershipRegistry();
    check(reg.harnessWindowId() === undefined, "windowId starts undefined");
    reg.setHarnessWindowId(101);
    check(reg.harnessWindowId() === 101, "setHarnessWindowId stores the id");
    let notified = 0;
    reg.onChange(() => { notified++; });
    reg.setHarnessWindowId(101);
    check(notified === 0, "setting the same windowId does not notify");
    reg.setHarnessWindowId(undefined);
    check(reg.harnessWindowId() === undefined && notified === 1, "clearing windowId notifies");
  }

  // ── newTab: creates the dedicated window and captures its real windowId. ──
  {
    const transport = createMockTransport();
    const client = createBrowserClient({ namespace: "t", transport });
    await client.start();
    const wid = client.ownership().harnessWindowId();
    check(typeof wid === "number", "attach captures a real windowId for the harness window");

    const first = await client.newTab("https://a.test");
    check(first.success, "newTab succeeds");
    if (first.success) {
      const t = transport.targets.get(first.data)!;
      check(t.windowId === wid, "new tab lands in the harness window (via openerId)");
      check(client.owns(first.data), "new tab is owned");
    }
  }

  // ── Popup adoption: a tab opened by an owned page is auto-owned. ──────────
  {
    const transport = createMockTransport();
    const client = createBrowserClient({ namespace: "t", transport });
    await client.start();
    const cur = client.current()!;

    // A page the session controls opens a child target (window.open / _blank).
    // Chrome emits Target.targetCreated with openerId = our owned tab; the
    // session must adopt it so the tab is controllable and cleaned up later.
    const child = await client.session().callBrowser("Target.createTarget", { url: "https://child.test", openerId: cur.targetId });
    await tick();
    check(child.success, "owned page opens a child target");
    if (child.success) {
      const id = (child.data as { targetId: string }).targetId;
      check(client.owns(id), "child target opened by an owned tab is auto-adopted");
    }

    // A target the user opens in their own window has no owned opener → never adopted.
    const stranger = await client.session().callBrowser("Target.createTarget", { url: "https://user.test", newWindow: true });
    await tick();
    if (stranger.success) {
      const id = (stranger.data as { targetId: string }).targetId;
      check(!client.owns(id), "target with no owned opener is not adopted");
    }
  }

  // ── Reattach self-heal: re-adopt live window-mates of a surviving owned tab. ─
  {
    const transport = createMockTransport();
    transport.seed({ targetId: "own-1", type: "page", url: "https://a.test", title: "", windowId: 500 });
    transport.seed({ targetId: "sib-2", type: "page", url: "https://b.test", title: "", windowId: 500, openerId: "own-1" });
    transport.seed({ targetId: "user-9", type: "page", url: "https://user.test", title: "", windowId: 700 });
    const client = createBrowserClient({
      namespace: "t",
      transport,
      initialOwnership: { ownedTargetIds: ["own-1"], harnessWindowTargetId: "own-1", harnessWindowId: 500 },
    });
    await client.start();
    check(client.owns("own-1"), "reattach: persisted owned tab stays owned");
    check(client.owns("sib-2"), "reattach: live window-mate (last session's popup) is re-adopted");
    check(!client.owns("user-9"), "reattach: a tab in a DIFFERENT window is never adopted");
  }

  // ── Restart-collision guard: stale windowId must not adopt the user's tabs. ─
  {
    const transport = createMockTransport();
    // Chrome restarted: our owned tab id is dead; windowId 500 now belongs to
    // the user's own window full of their tabs.
    transport.seed({ targetId: "user-a", type: "page", url: "https://user-a.test", title: "", windowId: 500 });
    transport.seed({ targetId: "user-b", type: "page", url: "https://user-b.test", title: "", windowId: 500 });
    const client = createBrowserClient({
      namespace: "t",
      transport,
      initialOwnership: { ownedTargetIds: ["dead-1"], harnessWindowTargetId: "dead-1", harnessWindowId: 500 },
    });
    await client.start();
    check(!client.owns("user-a") && !client.owns("user-b"), "restart: stale windowId does NOT adopt the user's tabs");
    check(client.ownership().harnessWindowId() !== 500, "restart: binds a fresh window instead of the colliding id");
    check(client.current() !== null && !["user-a", "user-b"].includes(client.current()!.targetId), "restart: attaches to a fresh harness tab, not a user tab");
  }

  // ── Teardown: closeOwnedTabs closes every owned tab + clears binding. ─────
  {
    const transport = createMockTransport();
    const client = createBrowserClient({ namespace: "t", transport });
    await client.start();
    await client.newTab("https://a.test");
    await client.newTab("https://b.test");
    const ownedBefore = client.ownership().list();
    check(ownedBefore.length >= 2, "several owned tabs before teardown");

    await client.closeOwnedTabs();
    check(client.ownership().list().length === 0, "closeOwnedTabs clears the owned set");
    check(client.ownership().harnessWindowId() === undefined, "closeOwnedTabs clears the windowId binding");
    check(ownedBefore.every((id) => transport.closed.includes(id)), "every owned tab was actually closed in the browser");
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
