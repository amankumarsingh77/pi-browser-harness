import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ToolDefinition } from "@mariozechner/pi-coding-agent";
import type { BrowserClient } from "../../src/client";
import type { RefSignature } from "../../src/cdp/types";
import { clickTool } from "../../src/domains/click";
import { executeJsTool } from "../../src/domains/js";
import { snapshotTool } from "../../src/domains/snapshot";
import { type Journal, type JournalEntry, createJournal, setActiveJournal } from "../../src/recipes/journal";
import { observeCall } from "../../src/recipes/recordable";
import { type ToolConcurrency, defineBrowserTool, setCallObserver } from "../../src/util/tool";
import { isRecord } from "../../src/util/guards";
import { ok } from "../../src/util/result";
import { type Canned, type FakeClientOptions, axNode, createFakeClient, evaluated, flush, handlerContext } from "../domains/fake-client";
import { pageInfoOf, withClient } from "../domains/client-overrides";

const BEFORE_URL = "https://example.test/start";

const sig = (role: string, name: string): RefSignature => ({ role, name, value: "", state: "" });

type Setup = {
  readonly canned?: Canned;
  readonly refs?: ReadonlyArray<{ readonly ref: string; readonly backendId: number; readonly sig: RefSignature }>;
  readonly evaluate?: FakeClientOptions["evaluate"];
  // URLs pageInfo reports, in call order; the last one repeats.
  readonly urls?: ReadonlyArray<string>;
};

const clientFor = async (setup: Setup): Promise<BrowserClient> => {
  const fake = await createFakeClient({
    ...(setup.canned !== undefined ? { canned: setup.canned } : {}),
    ...(setup.refs !== undefined ? { refs: setup.refs } : {}),
    ...(setup.evaluate !== undefined ? { evaluate: setup.evaluate } : {}),
  });
  const urls = [...(setup.urls ?? [BEFORE_URL])];
  return withClient(fake.client, {
    pageInfo: () => Promise.resolve(pageInfoOf({ url: (urls.length > 1 ? urls.shift() : urls[0]) ?? BEFORE_URL })),
  });
};

// Watches one call the way runHandler does: observe before, report the outcome after.
const observe = async (opts: {
  readonly client: BrowserClient;
  readonly name: string;
  readonly args: Readonly<Record<string, unknown>>;
  readonly concurrency?: ToolConcurrency;
}): Promise<void> => {
  const finish = await observeCall({ name: opts.name, concurrency: opts.concurrency ?? "serialized", args: opts.args, client: opts.client });
  await finish?.({ ok: true });
};

// pi's registerTool erases the tool's schema generics; the test only calls execute.
type RegisteredTool = Pick<ToolDefinition, "execute">;
const isRegisteredTool = (v: unknown): v is RegisteredTool => isRecord(v) && typeof v["execute"] === "function";

const tree = (...nodes: ReadonlyArray<{ readonly role: string; readonly name: string; readonly backendId: number }>) =>
  ok({
    nodes: [
      axNode("1", "RootWebArea", "", { childIds: nodes.map((_, i) => String(i + 2)) }),
      ...nodes.map((n, i) => axNode(String(i + 2), n.role, n.name, { parentId: "1", backendDOMNodeId: n.backendId })),
    ],
  });

describe("recipe journal recording", () => {
  let dir: string;
  let journal: Journal;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "pi-recordable-test-"));
    journal = createJournal(dir, "s-test");
    setActiveJournal(journal);
  });

  afterEach(() => {
    setActiveJournal(undefined);
    setCallObserver(undefined);
    rmSync(dir, { recursive: true, force: true });
  });

  const only = async (): Promise<JournalEntry> => {
    const entries = await journal.entries();
    assert.equal(entries.length, 1, `expected one journal entry, got ${entries.length}`);
    const [entry] = entries;
    assert.ok(entry);
    return entry;
  };

  test("SC1: clicking the second of two button \"Export\" refs journals role, name and nth 1, the pre-click URL, ok, and no ref", async () => {
    const client = await clientFor({
      refs: [
        { ref: "e1", backendId: 11, sig: sig("button", "Export") },
        { ref: "e2", backendId: 12, sig: sig("button", "Export") },
      ],
      urls: [BEFORE_URL, "https://example.test/after"],
    });

    await observe({ client, name: "browser_click", args: { ref: "e2" } });

    const entry = await only();
    assert.equal(entry.tool, "browser_click");
    assert.deepEqual(entry.locator, { role: "button", name: "Export", nth: 1 });
    assert.equal(entry.url, BEFORE_URL);
    assert.equal(entry.ok, true);
    assert.equal("ref" in entry.args, false);
  });

  test("SC2: browser_fill of hunter2 into a type=password field journals password true, an empty value, and never the secret", async () => {
    const client = await clientFor({
      refs: [{ ref: "e1", backendId: 11, sig: sig("textbox", "Password") }],
      canned: {
        "DOM.resolveNode": ok({ object: { type: "object", objectId: "o1" } }),
        "Runtime.callFunctionOn": evaluated(true),
      },
    });

    await observe({ client, name: "browser_fill", args: { ref: "e1", value: "hunter2" } });

    const entry = await only();
    assert.equal(entry.password, true);
    assert.equal(entry.args["value"], "");
    assert.equal(readFileSync(journal.path, "utf8").includes("hunter2"), false);
  });

  test("SC3: browser_type of hunter2 while a password input has focus journals password true and an empty text", async () => {
    const client = await clientFor({ evaluate: () => ok(true) });

    await observe({ client, name: "browser_type", args: { text: "hunter2" } });

    const entry = await only();
    assert.equal(entry.password, true);
    assert.equal(entry.args["text"], "");
  });

  test("SC4: a click at (120, 40) over the ref'd button \"Save\" journals the locator button \"Save\" nth 0", async () => {
    const client = await clientFor({
      refs: [{ ref: "e1", backendId: 21, sig: sig("button", "Save") }],
      canned: {
        "Runtime.evaluate": ok({ result: { type: "object", objectId: "hit-1" } }),
        "DOM.describeNode": ok({ node: { backendNodeId: 21 } }),
        "Accessibility.getFullAXTree": tree({ role: "button", name: "Save", backendId: 21 }),
      },
    });

    await observe({ client, name: "browser_click", args: { x: 120, y: 40 } });

    assert.deepEqual((await only()).locator, { role: "button", name: "Save", nth: 0 });
  });

  test("SC5: a click at (5, 5) where nothing interactive sits journals the point itself", async () => {
    const client = await clientFor({
      canned: { "Runtime.evaluate": ok({ result: { type: "object", subtype: "null", value: null } }) },
    });

    await observe({ client, name: "browser_click", args: { x: 5, y: 5 } });

    assert.deepEqual((await only()).locator, { x: 5, y: 5 });
  });

  test("SC6: after a click the change holds the new URL and only the named element that appeared", async () => {
    const client = await clientFor({
      refs: [{ ref: "e1", backendId: 11, sig: sig("button", "Export") }],
      urls: [BEFORE_URL, "https://example.test/done"],
      canned: {
        "Accessibility.getFullAXTree": [
          tree({ role: "button", name: "Export", backendId: 11 }),
          tree({ role: "button", name: "Export", backendId: 11 }, { role: "link", name: "Export complete", backendId: 12 }),
        ],
      },
    });

    await observe({ client, name: "browser_click", args: { ref: "e1" } });

    const change = (await only()).change;
    assert.equal(change?.url, "https://example.test/done");
    assert.deepEqual(change.appeared, [{ role: "link", name: "Export complete" }]);
  });

  test("SC6b: a status toast that appears after the call is journaled in appeared", async () => {
    let reads = 0;
    const client = await clientFor({
      refs: [{ ref: "e1", backendId: 11, sig: sig("button", "Export") }],
      canned: { "Accessibility.getFullAXTree": tree({ role: "button", name: "Export", backendId: 11 }) },
      evaluate: (expression) => {
        if (!expression.includes("liveMessages")) return ok(false);
        reads += 1;
        return ok(reads === 1 ? [] : [{ role: "status", name: "Export complete" }]);
      },
    });

    await observe({ client, name: "browser_click", args: { ref: "e1" } });

    assert.deepEqual((await only()).change?.appeared, [{ role: "status", name: "Export complete" }]);
  });

  test("SC34: an export click followed by Page.downloadWillBegin on the tab's session is journaled with change.download true", async () => {
    const fake = await createFakeClient({
      refs: [{ ref: "e1", backendId: 11, sig: sig("button", "Export CSV") }],
      canned: { "Accessibility.getFullAXTree": tree({ role: "button", name: "Export CSV", backendId: 11 }) },
    });
    const client = withClient(fake.client, { pageInfo: () => Promise.resolve(pageInfoOf({ url: BEFORE_URL })) });

    const finish = await observeCall({ name: "browser_click", concurrency: "serialized", args: { ref: "e1" }, client });
    fake.emit({ method: "Page.downloadWillBegin", sessionId: "s1", params: { guid: "g1", url: "https://example.test/x.csv", suggestedFilename: "x.csv" } });
    await flush();
    await finish?.({ ok: true });

    assert.equal((await only()).change?.download, true);
  });

  test("SC7: browser_execute_js is journaled as replayable false and a following browser_snapshot is not journaled", async () => {
    const client = await clientFor({});

    await observe({ client, name: executeJsTool.name, concurrency: executeJsTool.concurrency, args: { expression: "1" } });
    await observe({ client, name: snapshotTool.name, concurrency: snapshotTool.concurrency, args: {} });

    const entry = await only();
    assert.equal(entry.tool, "browser_execute_js");
    assert.equal(entry.replayable, false);
  });

  test("SC8: when the journal's append rejects, browser_click still resolves with its normal success text", async () => {
    let appends = 0;
    setActiveJournal({
      ...journal,
      append: () => {
        appends += 1;
        return Promise.reject(new Error("EIO: disk gone"));
      },
    });
    setCallObserver(observeCall);
    const client = await clientFor({
      canned: {
        "Accessibility.getFullAXTree": tree(),
        "Runtime.evaluate": ok({ result: { type: "object", subtype: "null", value: null } }),
      },
    });
    let registered: unknown;
    const pi: Pick<ExtensionAPI, "registerTool"> = {
      registerTool: (td) => {
        registered = td;
      },
    };
    // The daemon-socket gate is not under test; the real click handler and runHandler are.
    defineBrowserTool({ ...clickTool, ensureAlive: false }).register(pi, client);
    assert.ok(isRegisteredTool(registered), "click was not registered");

    const result = await registered.execute("id", { x: 10, y: 20 }, undefined, undefined, handlerContext(client).extensionCtx);

    assert.deepEqual(result.content, [{ type: "text", text: "Clicked at (10, 20)" }]);
    assert.equal(appends, 1, "the journal was never asked to append, so the rejection went untested");
  });

  test("SC61: four clicks in one run append the save-recipe offer hint to the third click's result only", async () => {
    await journal.beginRun();
    setCallObserver(observeCall);
    const client = await clientFor({
      canned: {
        "Accessibility.getFullAXTree": tree(),
        "Runtime.evaluate": ok({ result: { type: "object", subtype: "null", value: null } }),
      },
    });
    let registered: unknown;
    const pi: Pick<ExtensionAPI, "registerTool"> = {
      registerTool: (td) => {
        registered = td;
      },
    };
    defineBrowserTool({ ...clickTool, ensureAlive: false }).register(pi, client);
    assert.ok(isRegisteredTool(registered), "click was not registered");
    const click = registered;

    const texts: string[] = [];
    for (let i = 0; i < 4; i++) {
      const result = await click.execute("id", { x: 10, y: 20 }, undefined, undefined, handlerContext(client).extensionCtx);
      const [first] = result.content;
      texts.push(first?.type === "text" ? first.text : "");
    }

    const hinted = texts.map((t) => t.includes("browser_save_recipe"));
    assert.deepEqual(hinted, [false, false, true, false]);
    assert.match(texts[2] ?? "", /^Clicked at \(10, 20\)\n\n.*offer.*once/s);
  });

  test("SC62: after a failed replay in the run, the third click gets no save-recipe hint, since repair is the next step", async () => {
    await journal.beginRun();
    await journal.append({ source: "replay", tool: "browser_run_recipe", replayable: false, args: {}, password: false, url: BEFORE_URL, ok: false, recipe: { name: "r", step: 2 } });
    const client = await clientFor({});

    const notes: Array<string | undefined> = [];
    for (let i = 0; i < 3; i++) {
      const finish = await observeCall({ name: "browser_click", concurrency: "serialized", args: { x: 1, y: 1 }, client });
      notes.push(await finish?.({ ok: true }));
    }

    assert.deepEqual(notes, [undefined, undefined, undefined]);
  });

  test("SC83: a browser_execute_js read, after a snapshot that showed only button \"Go\" of a page that also has link \"Docs\", journals that nothing appeared", async () => {
    const client = await clientFor({
      refs: [{ ref: "e1", backendId: 11, sig: sig("button", "Go") }],
      canned: { "Accessibility.getFullAXTree": tree({ role: "button", name: "Go", backendId: 11 }, { role: "link", name: "Docs", backendId: 12 }) },
    });

    await observe({ client, name: "browser_execute_js", args: { expression: "document.title" } });

    assert.deepEqual((await only()).change?.appeared, []);
  });

  // A page whose fingerprint reads `prints` in turn (the last repeats); every other page script reads as false.
  const fingerprinted = async (prints: ReadonlyArray<string>) => {
    const left = [...prints];
    const fake = await createFakeClient({
      evaluate: (expression) => (expression.includes("pageFingerprint") ? ok((left.length > 1 ? left.shift() : left[0]) ?? "") : ok(false)),
    });
    return { fake, client: withClient(fake.client, { pageInfo: () => Promise.resolve(pageInfoOf({ url: BEFORE_URL })) }) };
  };

  test("SC88: a browser_execute_js that leaves the page's fingerprint as it was is journaled readOnly", async () => {
    const { client } = await fingerprinted(["f1"]);

    await observe({ client, name: "browser_execute_js", args: { expression: "document.title" } });

    assert.equal((await only()).readOnly, true);
  });

  test("SC89: a browser_execute_js after which the fingerprint changed, as when it set a field's value, is not readOnly", async () => {
    const { client } = await fingerprinted(["f1", "f2"]);

    await observe({ client, name: "browser_execute_js", args: { expression: "document.querySelector('#q').value = 'x'" } });

    assert.equal((await only()).readOnly, undefined);
  });

  test("SC90: a browser_execute_js during which the tab sent a POST is not readOnly, though the page looks the same", async () => {
    const { fake, client } = await fingerprinted(["f1"]);

    const finish = await observeCall({ name: "browser_execute_js", concurrency: "serialized", args: { expression: "fetch('/api', { method: 'POST' })" }, client });
    fake.emit({ method: "Network.requestWillBeSent", sessionId: "s1", params: { requestId: "r1", request: { method: "POST", url: "https://example.test/api" }, timestamp: 1, type: "Fetch" } });
    await flush();
    await finish?.({ ok: true });

    assert.equal((await only()).readOnly, undefined);
  });

  test("SC91: closing the current tab t1 is journaled replayable with no target id, and closing another tab t2 is not replayable", async () => {
    const client = await clientFor({});

    await observe({ client, name: "browser_close_tab", args: { targetId: "t1" } });
    await observe({ client, name: "browser_close_tab", args: { targetId: "t2" } });

    const [current, other] = await journal.entries();
    assert.equal(current?.replayable, true);
    assert.deepEqual(current.args, {});
    assert.equal(other?.replayable, false);
  });

  test("SC98: a click during which the tab sent a POST is journaled wrote: true", async () => {
    const fake = await createFakeClient({});
    const client = withClient(fake.client, { pageInfo: () => Promise.resolve(pageInfoOf({ url: BEFORE_URL })) });

    const finish = await observeCall({ name: "browser_click", concurrency: "serialized", args: { x: 1, y: 1 }, client });
    fake.emit({ method: "Network.requestWillBeSent", sessionId: "s1", params: { requestId: "r1", request: { method: "POST", url: "https://example.test/save" }, timestamp: 1, type: "XHR" } });
    await flush();
    await finish?.({ ok: true });

    assert.equal((await only()).wrote, true);
  });

  test("SC72: browser_wait_for on #month and browser_scroll at (10, 20) keep their selector and point, since neither has a locator", async () => {
    const client = await clientFor({});

    await observe({ client, name: "browser_wait_for", concurrency: "parallel", args: { selector: "#month" } });
    await observe({ client, name: "browser_scroll", args: { x: 10, y: 20, deltaY: 300 } });

    const [wait, scroll] = await journal.entries();
    assert.deepEqual(wait?.args, { selector: "#month" });
    assert.equal(wait.locator, undefined);
    assert.deepEqual(scroll?.args, { x: 10, y: 20, deltaY: 300 });
  });
});
