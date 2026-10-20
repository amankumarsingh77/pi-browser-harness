import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient, handlerContext } from "./fake-client";
import { pollUntil } from "../../src/domains/poll";
import { waitForTool, waitForLoadTool, waitTool } from "../../src/domains/page";
import { waitForIsolatedLoad } from "../../src/domains/isolated-tab";
import { ok } from "../../src/util/result";

describe("pollUntil", () => {
  test("resolves once the expression yields true", async () => {
    let calls = 0;
    const fake = await createFakeClient({ evaluate: () => ok(++calls >= 3) });
    const r = await pollUntil(fake.client, "ready()", { timeoutMs: 2_000, intervalMs: 1 });
    assert.equal(r.success, true);
    assert.equal(calls, 3);
  });

  test("a deadline is a typed timeout naming the condition", async () => {
    const fake = await createFakeClient({ evaluate: () => ok(false) });
    const r = await pollUntil(fake.client, "ready()", { timeoutMs: 20, intervalMs: 1, what: "the spinner to go" });
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.match(r.error.message, /the spinner to go/);
  });

  test("an abort mid-wait returns timeout instead of throwing", async () => {
    const ac = new AbortController();
    const fake = await createFakeClient({
      evaluate: () => {
        ac.abort();
        return ok(false);
      },
    });
    const r = await pollUntil(fake.client, "ready()", { timeoutMs: 10_000, intervalMs: 1, signal: ac.signal });
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
    assert.match(r.error.message, /Aborted/);
    assert.equal(fake.evaluated.length, 1);
  });

  test("evaluates on the given session", async () => {
    const seen: Array<string | undefined> = [];
    const fake = await createFakeClient({
      evaluate: (_expr, sessionId) => {
        seen.push(sessionId);
        return ok(true);
      },
    });
    await pollUntil(fake.client, "1", { timeoutMs: 100, sessionId: "iso-1" });
    assert.deepEqual(seen, ["iso-1"]);
  });
});

describe("wait tools never throw on abort", () => {
  test("browser_wait_for with an aborted signal returns a timeout error", async () => {
    const ac = new AbortController();
    ac.abort();
    const fake = await createFakeClient({ evaluate: () => ok(false) });
    const r = await waitForTool.handler({ selector: "#x", timeout: 5 }, handlerContext(fake.client, ac.signal));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
  });

  test("browser_wait_for_load aborted mid-poll returns a timeout error", async () => {
    const ac = new AbortController();
    const fake = await createFakeClient({
      evaluate: () => {
        ac.abort();
        return ok(false);
      },
    });
    const r = await waitForLoadTool.handler({ timeout: 5 }, handlerContext(fake.client, ac.signal));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
  });

  test("browser_wait aborted returns a timeout error rather than rejecting", async () => {
    const ac = new AbortController();
    const fake = await createFakeClient();
    setTimeout(() => { ac.abort(); }, 1);
    const r = await waitTool.handler({ seconds: 30 }, handlerContext(fake.client, ac.signal));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
  });

  test("browser_wait_for without a selector or text is invalid_args", async () => {
    const fake = await createFakeClient();
    const r = await waitForTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
  });

  test("an isolated-tab load wait aborted mid-poll returns a timeout error", async () => {
    const ac = new AbortController();
    const fake = await createFakeClient({
      evaluate: () => {
        ac.abort();
        return ok(false);
      },
    });
    const r = await waitForIsolatedLoad(fake.client, { targetId: "t9", sessionId: "s9" }, 5_000, ac.signal);
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
  });
});
