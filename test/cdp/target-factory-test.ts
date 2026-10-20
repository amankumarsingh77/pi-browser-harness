import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { ensureHarnessWindow, openHarnessTab } from "../../src/cdp/target-factory";
import { createCdpSession } from "../../src/cdp/session";
import { cdpError, type CdpError } from "../../src/cdp/errors";
import type { BrowserClient } from "../../src/client";
import type { CdpTransport } from "../../src/cdp/types";
import type { ProfilePin } from "../../src/profile/store";
import { type Result, err, ok } from "../../src/util/result";
import { asString } from "../../src/util/guards";
import { type Canned, type FakeClient, type RecordedCall, createFakeClient } from "../domains/fake-client";

type TargetRow = {
  readonly targetId: string;
  readonly url?: string;
  readonly browserContextId?: string;
};

const targets = (...rows: ReadonlyArray<TargetRow>): Canned => ({
  "Target.getTargets": ok({
    targetInfos: rows.map((r) => ({
      targetId: r.targetId,
      type: "page",
      title: r.targetId,
      url: r.url ?? "https://example.test/",
      ...(r.browserContextId !== undefined ? { browserContextId: r.browserContextId } : {}),
    })),
  }),
});

// What the fake attaches to at construction; a later listing may then differ.
const attachList = { targetInfos: [{ targetId: "t1", type: "page", title: "t1", url: "https://example.test/" }] };

const pin: ProfilePin = { userDataDir: "/udd", profileDir: "Profile 1", label: "Work", savedAt: "" };

type ClientOverrides = {
  readonly profilePin?: ProfilePin | null;
  readonly profileContextId?: string;
  readonly seed?: () => Promise<Result<string, CdpError>>;
};

type Harness = {
  readonly client: BrowserClient;
  readonly fake: FakeClient;
  readonly seedCalls: () => number;
};

// The shared fake pins nothing and never seeds; these tests need to vary both, so the client is
// re-shaped field by field (a BrowserClient is a plain record, so a spread stays fully typed).
const harness = async (
  canned: Canned,
  overrides: ClientOverrides = {},
  ownedTargetIds: ReadonlyArray<string> = ["t1"],
): Promise<Harness> => {
  const fake = await createFakeClient({ canned, ownedTargetIds });
  let seeds = 0;
  const client: BrowserClient = {
    ...fake.client,
    profilePin: () => overrides.profilePin ?? null,
    profileContextId: () => overrides.profileContextId,
    seedPinnedProfileWindow: () => {
      seeds++;
      const seed = overrides.seed;
      return seed ? seed() : Promise.resolve(err(cdpError("invalid_response", "seed not configured")));
    },
  };
  return { client, fake, seedCalls: () => seeds };
};

const createCalls = (fake: FakeClient): ReadonlyArray<RecordedCall> => fake.callsTo("Target.createTarget");

describe("ensureHarnessWindow", () => {
  test("reuses the recorded harness window when it is still alive", async () => {
    const h = await harness({ ...targets({ targetId: "t1" }, { targetId: "hw" }) });
    h.fake.ownership.add("hw");
    h.fake.ownership.setHarnessWindow("hw");
    const r = await ensureHarnessWindow(h.client);
    assert.deepEqual(r, ok({ targetId: "hw", freshlyCreated: false }));
    assert.equal(createCalls(h.fake).length, 0);
  });

  test("adopts a surviving owned tab when the recorded window is gone, and prunes dead ids", async () => {
    const h = await harness(targets({ targetId: "t1" }, { targetId: "owned-live" }), {}, ["t1", "owned-live", "owned-dead"]);
    h.fake.ownership.setHarnessWindow("hw-dead");
    const r = await ensureHarnessWindow(h.client);
    assert.equal(r.success, true);
    assert.equal(r.data.freshlyCreated, false);
    assert.ok(["t1", "owned-live"].includes(r.data.targetId), "survivor comes from the owned set");
    assert.equal(h.fake.ownership.harnessWindow(), r.data.targetId);
    assert.equal(h.fake.ownership.has("owned-dead"), false, "dead owned ids are reconciled away");
    assert.equal(createCalls(h.fake).length, 0);
  });

  test("creates a dedicated window when nothing owned survives, and records it with its window id", async () => {
    const h = await harness(
      {
        ...targets({ targetId: "stranger" }),
        "Target.createTarget": ok({ targetId: "fresh" }),
        "Browser.getWindowForTarget": ok({ windowId: 42 }),
      },
      {},
      ["gone"],
    );
    const r = await ensureHarnessWindow(h.client);
    assert.deepEqual(r, ok({ targetId: "fresh", freshlyCreated: true }));
    assert.deepEqual(createCalls(h.fake).map((c) => c.params), [{ url: "about:blank", newWindow: true }]);
    assert.equal(h.fake.ownership.harnessWindow(), "fresh");
    assert.equal(h.fake.ownership.has("fresh"), true);
    assert.equal(h.fake.ownership.harnessWindowId(), 42);
    assert.equal(h.fake.ownership.has("gone"), false);
    assert.equal(h.seedCalls(), 0, "an unpinned client never seeds a profile window");
  });

  test("a stranger tab is never adopted even when nothing is owned", async () => {
    const h = await harness({ ...targets({ targetId: "stranger" }), "Target.createTarget": ok({ targetId: "fresh" }) }, {}, []);
    const r = await ensureHarnessWindow(h.client);
    assert.equal(r.success && r.data.targetId, "fresh");
    assert.equal(h.fake.ownership.has("stranger"), false);
  });

  test("a window-id lookup failure does not fail creation", async () => {
    const h = await harness(
      {
        ...targets({ targetId: "stranger" }),
        "Target.createTarget": ok({ targetId: "fresh" }),
        "Browser.getWindowForTarget": err(cdpError("remote_error", "no window")),
      },
      {},
      [],
    );
    const r = await ensureHarnessWindow(h.client);
    assert.equal(r.success, true);
    assert.equal(h.fake.ownership.harnessWindowId(), undefined);
  });

  test("a failed target listing is returned as-is", async () => {
    const h = await harness({ "Target.getTargets": [ok(attachList), err(cdpError("transport_closed", "gone"))] });
    const r = await ensureHarnessWindow(h.client);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "transport_closed");
    assert.equal(createCalls(h.fake).length, 0);
  });

  test("a failed createTarget is returned and nothing is recorded", async () => {
    const h = await harness(
      // The first createTarget is the fake's own boot attach; the one under test is the second.
      { ...targets({ targetId: "stranger" }), "Target.createTarget": [ok({ targetId: "boot" }), err(cdpError("remote_error", "denied"))] },
      {},
      [],
    );
    const r = await ensureHarnessWindow(h.client);
    assert.equal(r.success, false);
    assert.equal(h.fake.ownership.harnessWindow(), undefined);
    assert.equal(h.fake.ownership.list().length, 0);
  });

  test("with a pin but no resolved profile context, a live harness window is not trusted and a seed runs instead", async () => {
    const h = await harness(targets({ targetId: "t1" }, { targetId: "hw" }), {
      profilePin: pin,
      seed: () => Promise.resolve(ok("seeded")),
    });
    h.fake.ownership.add("hw");
    h.fake.ownership.setHarnessWindow("hw");
    const r = await ensureHarnessWindow(h.client);
    assert.deepEqual(r, ok({ targetId: "seeded", freshlyCreated: true }));
    assert.equal(h.seedCalls(), 1);
    assert.equal(createCalls(h.fake).length, 0, "a pinned client never creates a bare target");
  });

  test("with a pin and a resolved context, a harness window in that context is reused", async () => {
    const h = await harness(targets({ targetId: "t1" }, { targetId: "hw", browserContextId: "ctx-pinned" }), {
      profilePin: pin,
      profileContextId: "ctx-pinned",
    });
    h.fake.ownership.add("hw");
    h.fake.ownership.setHarnessWindow("hw");
    const r = await ensureHarnessWindow(h.client);
    assert.deepEqual(r, ok({ targetId: "hw", freshlyCreated: false }));
    assert.equal(h.seedCalls(), 0);
  });

  test("with a pin and a resolved context, tabs from another profile are skipped and a seed runs", async () => {
    const h = await harness(
      targets({ targetId: "t1", browserContextId: "ctx-other" }, { targetId: "hw", browserContextId: "ctx-other" }),
      { profilePin: pin, profileContextId: "ctx-pinned", seed: () => Promise.resolve(ok("seeded")) },
      ["t1", "hw"],
    );
    h.fake.ownership.setHarnessWindow("hw");
    const r = await ensureHarnessWindow(h.client);
    assert.deepEqual(r, ok({ targetId: "seeded", freshlyCreated: true }));
    assert.equal(h.seedCalls(), 1);
  });

  test("a seed failure is propagated", async () => {
    const h = await harness({ ...targets({ targetId: "stranger" }), "Target.createTarget": ok({ targetId: "boot" }) }, {
      profilePin: pin,
      seed: () => Promise.resolve(err(cdpError("timeout", "no window"))),
    }, []);
    const r = await ensureHarnessWindow(h.client);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
  });

  test("concurrent callers share one creation and only the initiator is told it is fresh", async () => {
    const h = await harness({ ...targets({ targetId: "stranger" }), "Target.createTarget": ok({ targetId: "fresh" }) }, {}, []);
    const [a, b, c] = await Promise.all([
      ensureHarnessWindow(h.client),
      ensureHarnessWindow(h.client),
      ensureHarnessWindow(h.client),
    ]);
    assert.deepEqual(a, ok({ targetId: "fresh", freshlyCreated: true }));
    assert.deepEqual(b, ok({ targetId: "fresh", freshlyCreated: false }));
    assert.deepEqual(c, ok({ targetId: "fresh", freshlyCreated: false }));
    assert.equal(createCalls(h.fake).length, 1);
  });

  test("concurrent callers all see the same failure", async () => {
    const h = await harness({ "Target.getTargets": [ok(attachList), err(cdpError("transport_closed", "gone"))] });
    const [a, b] = await Promise.all([ensureHarnessWindow(h.client), ensureHarnessWindow(h.client)]);
    assert.equal(a.success, false);
    assert.equal(b.success, false);
  });

  test("after the shared attempt settles, a later call starts a fresh attempt", async () => {
    const h = await harness({ ...targets({ targetId: "t1" }), "Target.createTarget": ok({ targetId: "fresh" }) }, {}, []);
    const first = await ensureHarnessWindow(h.client);
    assert.equal(first.success && first.data.freshlyCreated, true);
    // The second listing does not show "fresh" (static canned reply), so the recorded window is
    // reconciled away and a second creation happens: proof the in-flight slot was cleared.
    const second = await ensureHarnessWindow(h.client);
    assert.equal(second.success && second.data.freshlyCreated, true);
    assert.equal(createCalls(h.fake).length, 2);
  });
});

describe("openHarnessTab", () => {
  test("without a profile context, creates a target with the opener and takes ownership", async () => {
    const h = await harness({ "Target.createTarget": ok({ targetId: "child" }) });
    const r = await openHarnessTab(h.client, "t1");
    assert.deepEqual(r, ok("child"));
    assert.deepEqual(createCalls(h.fake).map((c) => c.params), [{ url: "about:blank", openerId: "t1" }]);
    assert.equal(h.fake.ownership.has("child"), true);
    assert.equal(h.fake.callsTo("Runtime.evaluate").length, 0);
  });

  test("without a profile context, a createTarget failure is returned and nothing is owned", async () => {
    const h = await harness({ "Target.createTarget": err(cdpError("remote_error", "nope")) });
    const r = await openHarnessTab(h.client, "t1");
    assert.equal(r.success, false);
    assert.deepEqual(h.fake.ownership.list(), ["t1"]);
  });

  // With a context pinned, the tab is opened by `window.open` inside the opener and found again by
  // the token in its URL; the token is random, so the listing is answered from the recorded call.
  const spawningClient = async (opened: boolean): Promise<Harness & { readonly evaluateParams: () => Record<string, unknown> | undefined }> => {
    const fake = await createFakeClient({
      canned: { "Runtime.evaluate": ok({ result: { type: "boolean", value: opened } }) },
    });
    let token: string | undefined;
    const inner = fake.client.transport();
    const transport: CdpTransport = {
      ...inner,
      request: (method, params, opts) => {
        if (method === "Runtime.evaluate") {
          const expression = asString(params["expression"]) ?? "";
          token = /about:blank#(pi-[0-9a-f-]+)/.exec(expression)?.[1];
        }
        if (method === "Target.getTargets" && token !== undefined) {
          fake.calls.push({ method, params, sessionId: opts?.sessionId });
          return Promise.resolve(ok({
            targetInfos: [
              { targetId: "t1", type: "page", title: "", url: "https://example.test/" },
              { targetId: "spawned", type: "page", title: "", url: `about:blank#${token}`, browserContextId: "ctx" },
            ],
          }));
        }
        return inner.request(method, params, opts);
      },
    };
    // The session was built on the inner transport; route its calls through the wrapper by
    // rebuilding the client surface the factory touches.
    const session = createCdpSession(transport, fake.ownership);
    const attached = await session.attachFirstPage();
    assert.ok(attached.success);
    fake.calls.length = 0;
    const client: BrowserClient = {
      ...fake.client,
      session: () => session,
      transport: () => transport,
      profilePin: () => pin,
      profileContextId: () => "ctx",
    };
    return {
      client,
      fake,
      seedCalls: () => 0,
      evaluateParams: () => fake.callsTo("Runtime.evaluate")[0]?.params,
    };
  };

  test("with a profile context, opens the tab via window.open in the opener with a user gesture", async () => {
    const h = await spawningClient(true);
    const r = await openHarnessTab(h.client, "t1");
    assert.deepEqual(r, ok("spawned"));
    const params = h.evaluateParams();
    assert.ok(params);
    assert.equal(params["userGesture"], true);
    assert.equal(params["returnByValue"], true);
    assert.match(asString(params["expression"]) ?? "", /^!!window\.open\("about:blank#pi-[0-9a-f-]+", '_blank'\)$/);
    assert.equal(h.fake.callsTo("Runtime.evaluate")[0]?.sessionId, "s1", "evaluated on the opener's tracked session");
    assert.equal(createCalls(h.fake).length, 0, "no bare createTarget in a pinned profile");
    assert.equal(h.fake.callsTo("Target.detachFromTarget").length, 0, "a tracked session is not detached");
    assert.equal(h.fake.ownership.has("spawned"), true);
  });

  test("with a profile context, a blocked window.open is reported as invalid_response and nothing is owned", async () => {
    const h = await spawningClient(false);
    const r = await openHarnessTab(h.client, "t1");
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_response");
    assert.match(r.error.message, /blocked window\.open/);
    assert.equal(h.fake.callsTo("Target.getTargets").length, 0, "no polling after a refusal");
    assert.deepEqual(h.fake.ownership.list(), ["t1"]);
  });

  test("with a profile context, the opener session is borrowed and released even when the evaluate fails", async () => {
    const fake = await createFakeClient({
      canned: {
        "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-borrow" })],
        "Runtime.evaluate": err(cdpError("remote_error", "ctx destroyed")),
      },
    });
    const client: BrowserClient = { ...fake.client, profileContextId: () => "ctx" };
    const r = await openHarnessTab(client, "untracked-opener");
    assert.equal(r.success, false);
    assert.equal(r.error.message, "ctx destroyed");
    assert.deepEqual(fake.callsTo("Target.attachToTarget").map((c) => c.params), [{ targetId: "untracked-opener", flatten: true }]);
    assert.deepEqual(fake.callsTo("Target.detachFromTarget").map((c) => c.params), [{ sessionId: "s-borrow" }]);
    assert.equal(fake.callsTo("Runtime.evaluate")[0]?.sessionId, "s-borrow");
  });

  test("with a profile context, the expression embeds the token through safeJs, never raw", async () => {
    const h = await spawningClient(true);
    await openHarnessTab(h.client, "t1");
    const expression = asString(h.evaluateParams()?.["expression"]) ?? "";
    const literal = /window\.open\(("[^"]*")/.exec(expression)?.[1];
    assert.ok(literal);
    const parsed: unknown = JSON.parse(literal);
    assert.ok(typeof parsed === "string" && parsed.startsWith("about:blank#pi-"));
  });
});
