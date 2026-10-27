import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createExtension } from "../../src/index";
import type { TabInfo } from "../../src/cdp/types";
import { createJournal } from "../../src/recipes/journal";
import { ok } from "../../src/util/result";
import { createFakeClient, createStubTransport } from "../domains/fake-client";
import { pageInfoOf, withClient } from "../domains/client-overrides";
import { fakeCtx, fakePi } from "../helpers/fake-pi";

const ONE_TAB: ReadonlyArray<TabInfo> = [{ targetId: "t1", title: "Fake", url: "https://example.test/", owned: true }];

// runHandler refuses every daemon-backed tool unless the daemon's socket file exists; win32 skips that filesystem
// probe, which lets the real tool run against the fake client without touching the developer's /tmp socket.
const withDaemonProbeSkipped = async (fn: () => Promise<void>): Promise<void> => {
  const original = Object.getOwnPropertyDescriptor(process, "platform");
  Object.defineProperty(process, "platform", { value: "win32", configurable: true });
  try {
    await fn();
  } finally {
    if (original) Object.defineProperty(process, "platform", original);
  }
};

describe("journal wiring through the extension", () => {
  let agentDir: string;
  let savedAgentDir: string | undefined;

  before(() => {
    agentDir = mkdtempSync(join(tmpdir(), "pi-journal-ext-test-"));
    savedAgentDir = process.env["PI_CODING_AGENT_DIR"];
    process.env["PI_CODING_AGENT_DIR"] = agentDir;
  });

  after(() => {
    if (savedAgentDir === undefined) Reflect.deleteProperty(process.env, "PI_CODING_AGENT_DIR");
    else process.env["PI_CODING_AGENT_DIR"] = savedAgentDir;
    rmSync(agentDir, { recursive: true, force: true });
  });

  test("SC11: browser_navigate run through pi after agent_start writes one run-1 entry to <agentDir>/browser-harness/journal/s-123.jsonl, 0600 in a 0700 dir", async () => {
    const fake = await createFakeClient({ canned: { "Page.navigate": ok({ frameId: "f1" }) } });
    const client = withClient(fake.client, {
      listTabs: () => Promise.resolve(ok(ONE_TAB)),
      pageInfo: () => Promise.resolve(pageInfoOf({ url: "https://example.test/a" })),
    });
    const pi = fakePi();
    createExtension({
      createTransport: () => createStubTransport().transport,
      createClient: () => client,
      readPin: () => Promise.resolve(null),
    })(pi.pi);
    const { ctx } = fakeCtx({ sessionId: "s-123" });

    await pi.emit("session_start", { type: "session_start" }, ctx);
    await pi.emit("agent_start", { type: "agent_start" }, ctx);
    await withDaemonProbeSkipped(async () => {
      await pi.tool("browser_navigate").execute("call-1", { url: "https://example.test/a" }, undefined, undefined, ctx);
    });

    const file = join(agentDir, "browser-harness", "journal", "s-123.jsonl");
    assert.equal(statSync(file).mode & 0o777, 0o600);
    assert.equal(statSync(dirname(file)).mode & 0o777, 0o700);
    const entries = await createJournal(dirname(file), "s-123").entries();
    assert.equal(entries.length, 1);
    const [entry] = entries;
    assert.equal(entry?.tool, "browser_navigate");
    assert.equal(entry.run, 1);
    assert.equal(entry.args["url"], "https://example.test/a");
    assert.equal(entry.replayable, true);
  });
});
