import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient, type FakeClient } from "./fake-client";
import { handlerContext } from "./fake-client";
import { withClient } from "./client-overrides";
import { closeTabTool, currentTabTool, listTabsTool, newTabTool, switchTabTool } from "../../src/domains/tabs";
import { type CdpError, cdpError } from "../../src/cdp/errors";
import type { TabInfo } from "../../src/cdp/types";
import { type Result, err, ok } from "../../src/util/result";

const TABS: ReadonlyArray<TabInfo> = [
  { targetId: "t1", title: "Mine", url: "https://example.test/mine", owned: true },
  { targetId: "u2", title: "Theirs", url: "https://example.test/theirs", owned: false },
];

const OWNED = ["t1", "AAAAAAAA1111", "AAAAAAAA2222", "BBBBBBBB0000"];

const multiOwned = (): Promise<FakeClient> =>
  createFakeClient({
    ownedTargetIds: OWNED,
    canned: {
      "Target.getTargets": ok({
        targetInfos: OWNED.map((targetId) => ({ targetId, type: "page", title: targetId, url: "https://example.test/" })),
      }),
    },
  });

describe("browser_list_tabs", () => {
  test("defaults to owned tabs, including internal pages, and stores the filtered list in details", async () => {
    const fake = await createFakeClient();
    const seen: Array<boolean | undefined> = [];
    const client = withClient(fake.client, {
      listTabs: (includeInternal) => {
        seen.push(includeInternal);
        return Promise.resolve(ok(TABS));
      },
    });
    const r = await listTabsTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.deepEqual(seen, [true]);
    assert.equal(r.data.text, "Owned tabs (1):\n  ★ [0] t1 https://example.test/mine\n      Mine");
    assert.deepEqual(r.data.details, { tabs: [TABS[0]], scope: "owned" });
  });

  test("scope:'all' lists every tab and flags the owned ones", async () => {
    const fake = await createFakeClient();
    const client = withClient(fake.client, { listTabs: () => Promise.resolve(ok(TABS)) });
    const r = await listTabsTool.handler({ scope: "all", includeInternal: false }, handlerContext(client));
    assert.equal(r.success, true);
    assert.equal(
      r.data.text,
      "All tabs (2, ★ = owned by this session):\n" +
        "  ★ [0] t1 https://example.test/mine\n      Mine\n" +
        "    [1] u2 https://example.test/theirs\n      Theirs",
    );
    assert.deepEqual(r.data.details, { tabs: TABS, scope: "all" });
  });

  test("includeInternal:false is forwarded to the client", async () => {
    const fake = await createFakeClient();
    const seen: Array<boolean | undefined> = [];
    const client = withClient(fake.client, {
      listTabs: (includeInternal) => {
        seen.push(includeInternal);
        return Promise.resolve(ok([]));
      },
    });
    const r = await listTabsTool.handler({ includeInternal: false }, handlerContext(client));
    assert.equal(r.success, true);
    assert.deepEqual(seen, [false]);
    assert.equal(r.data.text, "Owned tabs (0):\n");
  });

  test("a listing failure is a cdp_error attributed to Target.getTargets", async () => {
    const fake = await createFakeClient();
    const client = withClient(fake.client, {
      listTabs: () => Promise.resolve(err(cdpError("transport_closed", "socket closed"))),
    });
    const r = await listTabsTool.handler({}, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "socket closed");
    assert.deepEqual(r.error.details, { method: "Target.getTargets" });
  });
});

describe("browser_current_tab", () => {
  const INFO = ok({ targetInfo: { targetId: "t1", type: "page", title: "Mine", url: "https://example.test/mine" } });

  test("looks the attached target up and marks it owned", async () => {
    const fake = await createFakeClient({ canned: { "Target.getTargetInfo": INFO } });
    const r = await currentTabTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(fake.calls.map((c) => [c.method, c.params, c.sessionId]), [
      ["Target.getTargetInfo", { targetId: "t1" }, null],
    ]);
    assert.equal(r.data.text, "Current tab (owned):\n  t1\n  https://example.test/mine\n  Mine");
    assert.deepEqual(r.data.details, { targetId: "t1", url: "https://example.test/mine", title: "Mine", owned: true });
  });

  test("a tab the session does not own is flagged", async () => {
    const fake = await createFakeClient({
      canned: { "Target.getTargetInfo": ok({ targetInfo: { targetId: "zz", type: "page", title: "Other", url: "https://x.test/" } }) },
    });
    const r = await currentTabTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.match(r.data.text, /^Current tab \(NOT owned by this session\):/);
    assert.equal(r.data.details?.["owned"], false);
  });

  test("no attached tab is invalid_state without a CDP round trip", async () => {
    const fake = await createFakeClient();
    const client = withClient(fake.client, { current: () => null });
    const r = await currentTabTool.handler({}, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.equal(r.error.message, "No tab attached.");
    assert.equal(fake.calls.length, 0);
  });

  test("a lookup failure names Target.getTargetInfo", async () => {
    const fake = await createFakeClient({ canned: { "Target.getTargetInfo": err(cdpError("remote_error", "No target with given id")) } });
    const r = await currentTabTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "Target.getTargetInfo" });
  });
});

describe("browser_switch_tab", () => {
  const switching = (fake: FakeClient, outcome: Result<void, CdpError>, switched: string[]) =>
    withClient(fake.client, {
      switchTab: (id) => {
        switched.push(id);
        return Promise.resolve(outcome);
      },
    });

  test("an exact owned id is switched to as given", async () => {
    const fake = await multiOwned();
    const switched: string[] = [];
    const r = await switchTabTool.handler({ targetId: "BBBBBBBB0000" }, handlerContext(switching(fake, ok(undefined), switched)));
    assert.equal(r.success, true);
    assert.deepEqual(switched, ["BBBBBBBB0000"]);
    assert.equal(r.data.text, "Switched to BBBBBBBB0000");
    assert.deepEqual(r.data.details, { targetId: "BBBBBBBB0000" });
  });

  test("a unique prefix is expanded and the expansion is reported", async () => {
    const fake = await multiOwned();
    const switched: string[] = [];
    const r = await switchTabTool.handler({ targetId: "BBBBBBBB" }, handlerContext(switching(fake, ok(undefined), switched)));
    assert.equal(r.success, true);
    assert.deepEqual(switched, ["BBBBBBBB0000"]);
    assert.equal(r.data.text, 'Switched to BBBBBBBB0000 (resolved from prefix "BBBBBBBB")');
    assert.deepEqual(r.data.details, { targetId: "BBBBBBBB0000" });
  });

  test("an ambiguous prefix is invalid_args and the client is not asked to switch", async () => {
    const fake = await multiOwned();
    const switched: string[] = [];
    const r = await switchTabTool.handler({ targetId: "AAAAAAAA" }, handlerContext(switching(fake, ok(undefined), switched)));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
    assert.deepEqual(r.error.details, { matches: ["AAAAAAAA1111", "AAAAAAAA2222"] });
    assert.deepEqual(switched, []);
  });

  test("an unowned id is refused with the namespace in the details", async () => {
    const fake = await multiOwned();
    const r = await switchTabTool.handler({ targetId: "CCCCCCCC0000" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.match(r.error.message, /Tab CCCCCCCC0000 is not owned by this harness session \(namespace: fake\)/);
    assert.deepEqual(r.error.details, { targetId: "CCCCCCCC0000", namespace: "fake" });
  });

  test("a switch failure is attributed to Target.attachToTarget unless the error names its own method", async () => {
    const fake = await multiOwned();
    const bare = await switchTabTool.handler({ targetId: "t1" }, handlerContext(switching(fake, err(cdpError("remote_error", "gone")), [])));
    assert.equal(bare.success, false);
    assert.equal(bare.error.kind, "cdp_error");
    assert.deepEqual(bare.error.details, { method: "Target.attachToTarget" });

    const named = await switchTabTool.handler(
      { targetId: "t1" },
      handlerContext(switching(fake, err(cdpError("timeout", "slow", "Target.activateTarget")), [])),
    );
    assert.equal(named.success, false);
    assert.equal(named.error.kind, "timeout");
    assert.deepEqual(named.error.details, { method: "Target.activateTarget" });
  });
});

describe("browser_new_tab", () => {
  test("opens a tab and reports the url when one was given", async () => {
    const fake = await createFakeClient();
    const urls: Array<string | undefined> = [];
    const client = withClient(fake.client, {
      newTab: (url) => {
        urls.push(url);
        return Promise.resolve(ok("t9"));
      },
    });
    const r = await newTabTool.handler({ url: "https://example.test/new" }, handlerContext(client));
    assert.equal(r.success, true);
    assert.deepEqual(urls, ["https://example.test/new"]);
    assert.equal(r.data.text, "New tab: t9 (https://example.test/new)");
    assert.deepEqual(r.data.details, { targetId: "t9", url: "https://example.test/new" });
  });

  test("without a url the details carry only the target id", async () => {
    const fake = await createFakeClient();
    const client = withClient(fake.client, { newTab: () => Promise.resolve(ok("t9")) });
    const r = await newTabTool.handler({}, handlerContext(client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "New tab: t9");
    assert.deepEqual(r.data.details, { targetId: "t9" });
  });

  test("a creation failure is attributed to Target.createTarget", async () => {
    const fake = await createFakeClient();
    const client = withClient(fake.client, {
      newTab: () => Promise.resolve(err(cdpError("invalid_response", "the browser blocked window.open"))),
    });
    const r = await newTabTool.handler({}, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "Target.createTarget" });
  });
});

describe("browser_close_tab", () => {
  test("closes an exact owned id through the client", async () => {
    const fake = await multiOwned();
    const closed: string[] = [];
    const client = withClient(fake.client, {
      closeTab: (id) => {
        closed.push(id);
        return Promise.resolve(ok(undefined));
      },
    });
    const r = await closeTabTool.handler({ targetId: "AAAAAAAA1111" }, handlerContext(client));
    assert.equal(r.success, true);
    assert.deepEqual(closed, ["AAAAAAAA1111"]);
    assert.equal(r.data.text, "Closed tab AAAAAAAA1111");
    assert.deepEqual(r.data.details, { targetId: "AAAAAAAA1111" });
  });

  test("refuses an unowned tab before touching the client", async () => {
    const fake = await multiOwned();
    const closed: string[] = [];
    const client = withClient(fake.client, {
      closeTab: (id) => {
        closed.push(id);
        return Promise.resolve(ok(undefined));
      },
    });
    const r = await closeTabTool.handler({ targetId: "CCCCCCCC0000" }, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.deepEqual(closed, []);
  });

  test("a close failure is attributed to Target.closeTarget", async () => {
    const fake = await multiOwned();
    const client = withClient(fake.client, {
      closeTab: () => Promise.resolve(err(cdpError("remote_error", "No target with given id"))),
    });
    const r = await closeTabTool.handler({ targetId: "t1" }, handlerContext(client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "Target.closeTarget" });
  });
});
