import { test, describe, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakeClient, type FakeClient } from "./fake-client";
import { downloadTool, restoreDownloadBehavior } from "../../src/domains/files";
import type { HandlerContext } from "../../src/util/tool";
import { cdpError } from "../../src/cdp/errors";
import { err } from "../../src/util/result";
import { Value } from "typebox/value";

const SET_BEHAVIOR = "Browser.setDownloadBehavior";

const ctxFor = (fake: FakeClient): HandlerContext => ({
  client: fake.client,
  signal: undefined,
  onUpdate: () => {},
  extensionCtx: undefined as never,
});

const behaviorCalls = (fake: FakeClient): ReadonlyArray<Record<string, unknown>> =>
  fake.callsTo(SET_BEHAVIOR).map((c) => c.params);

const withTmp = async (fn: (dir: string) => Promise<void>): Promise<void> => {
  const dir = await mkdtemp(join(tmpdir(), "bh-download-test-"));
  try {
    await fn(dir);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};

// The override flag is module state, so every test starts from "nothing set".
beforeEach(async () => {
  await downloadTool.handler({ restore: true }, ctxFor(await createFakeClient()));
});

describe("browser_download sets and restores Chrome's download behavior", () => {
  test("restore resets to the browser default without a path", async () => {
    const fake = await createFakeClient();
    const r = await downloadTool.handler({ restore: true }, ctxFor(fake));
    assert.equal(r.success, true);
    const calls = behaviorCalls(fake);
    assert.equal(calls.length, 1);
    assert.equal(calls[0]?.["behavior"], "default");
    assert.equal(calls[0]?.["downloadPath"], undefined);
  });

  test("a download path sets an allow behavior pointing at it", async () => {
    await withTmp(async (dir) => {
      const fake = await createFakeClient();
      const r = await downloadTool.handler({ downloadPath: dir }, ctxFor(fake));
      assert.equal(r.success, true);
      const calls = behaviorCalls(fake);
      assert.equal(calls.length, 1);
      assert.equal(calls[0]?.["behavior"], "allow");
      assert.equal(calls[0]?.["downloadPath"], dir);
    });
  });

  test("restore and downloadPath together are refused before any CDP call", async () => {
    const fake = await createFakeClient();
    const r = await downloadTool.handler({ restore: true, downloadPath: "/tmp/whatever" }, ctxFor(fake));
    assert.equal(r.success, false);
    if (r.success) return;
    assert.equal(r.error.kind, "invalid_state");
    assert.match(r.error.message, /not both/);
    assert.equal(fake.callsTo(SET_BEHAVIOR).length, 0);
  });

  test("neither argument is refused before any CDP call", async () => {
    const fake = await createFakeClient();
    const r = await downloadTool.handler({}, ctxFor(fake));
    assert.equal(r.success, false);
    if (r.success) return;
    assert.equal(r.error.kind, "invalid_state");
    assert.match(r.error.message, /restore:true to undo/);
    assert.equal(fake.callsTo(SET_BEHAVIOR).length, 0);
  });

  test("an explicit restore:false is not a restore", async () => {
    await withTmp(async (dir) => {
      const fake = await createFakeClient();
      const r = await downloadTool.handler({ restore: false, downloadPath: dir }, ctxFor(fake));
      assert.equal(r.success, true);
      assert.equal(behaviorCalls(fake)[0]?.["behavior"], "allow");
    });
  });

  test("restore:false without a path is refused rather than defaulting to a restore", async () => {
    const fake = await createFakeClient();
    const r = await downloadTool.handler({ restore: false }, ctxFor(fake));
    assert.equal(r.success, false);
    if (r.success) return;
    assert.equal(r.error.kind, "invalid_state");
    assert.equal(fake.callsTo(SET_BEHAVIOR).length, 0);
  });

  test("a failed restore CDP call is reported, not swallowed", async () => {
    const fake = await createFakeClient({
      canned: { [SET_BEHAVIOR]: err(cdpError("remote_error", "not allowed in this context")) },
    });
    const r = await downloadTool.handler({ restore: true }, ctxFor(fake));
    assert.equal(r.success, false);
    if (r.success) return;
    assert.equal(r.error.kind, "cdp_error");
    assert.match(r.error.message, /not allowed in this context/);
  });

  test("a path that is an existing file is refused", async () => {
    await withTmp(async (dir) => {
      const file = join(dir, "not-a-dir");
      await writeFile(file, "x");
      const fake = await createFakeClient();
      const r = await downloadTool.handler({ downloadPath: file }, ctxFor(fake));
      assert.equal(r.success, false);
      if (r.success) return;
      assert.equal(r.error.kind, "io_error");
      assert.equal(fake.callsTo(SET_BEHAVIOR).length, 0);
    });
  });
});

describe("the schema is permissive and the handler is the guard", () => {
  const schema = downloadTool.parameters;

  test("wrong types are refused by the schema, so they never reach the handler", () => {
    assert.equal(Value.Check(schema, { restore: "yes" }), false);
    assert.equal(Value.Check(schema, { downloadPath: 5 }), false);
  });

  test("both-optional means the ambiguous combinations pass the schema and are refused in the handler", () => {
    assert.equal(Value.Check(schema, {}), true);
    assert.equal(Value.Check(schema, { restore: true, downloadPath: "/tmp/x" }), true);
  });

  test("the accepted shapes are the ones the handler acts on", () => {
    assert.equal(Value.Check(schema, { restore: true }), true);
    assert.equal(Value.Check(schema, { downloadPath: "/tmp/x" }), true);
  });
});

describe("session teardown undoes an override that is still in force", () => {
  test("a teardown with no override in force sends nothing", async () => {
    const fake = await createFakeClient();
    const r = await restoreDownloadBehavior(fake.client);
    assert.equal(r.success, true);
    assert.equal(fake.callsTo(SET_BEHAVIOR).length, 0);
  });

  test("a teardown after a set restores the default exactly once", async () => {
    await withTmp(async (dir) => {
      const fake = await createFakeClient();
      const set = await downloadTool.handler({ downloadPath: dir }, ctxFor(fake));
      assert.equal(set.success, true);

      const first = await restoreDownloadBehavior(fake.client);
      const second = await restoreDownloadBehavior(fake.client);
      assert.equal(first.success, true);
      assert.equal(second.success, true);

      const calls = behaviorCalls(fake);
      assert.equal(calls.length, 2);
      assert.equal(calls[0]?.["behavior"], "allow");
      assert.equal(calls[1]?.["behavior"], "default");
    });
  });

  test("an explicit restore clears the override, so teardown is a no-op", async () => {
    await withTmp(async (dir) => {
      const fake = await createFakeClient();
      await downloadTool.handler({ downloadPath: dir }, ctxFor(fake));
      await downloadTool.handler({ restore: true }, ctxFor(fake));
      const r = await restoreDownloadBehavior(fake.client);
      assert.equal(r.success, true);
      assert.equal(fake.callsTo(SET_BEHAVIOR).length, 2);
    });
  });

  test("a failed teardown reports the failure and keeps the override pending for a retry", async () => {
    await withTmp(async (dir) => {
      const setFake = await createFakeClient();
      await downloadTool.handler({ downloadPath: dir }, ctxFor(setFake));

      const failing = await createFakeClient({
        canned: { [SET_BEHAVIOR]: err(cdpError("transport_closed", "socket closed")) },
      });
      const failed = await restoreDownloadBehavior(failing.client);
      assert.equal(failed.success, false);
      if (failed.success) return;
      assert.equal(failed.error.kind, "cdp_error");
      assert.match(failed.error.message, /socket closed/);
      assert.ok(
        failed.error.message.includes(dir),
        `the warning has to name the directory that is still hijacked: ${failed.error.message}`,
      );

      const retry = await createFakeClient();
      const second = await restoreDownloadBehavior(retry.client);
      assert.equal(second.success, true);
      assert.equal(behaviorCalls(retry)[0]?.["behavior"], "default");
    });
  });
});
