/**
 * Unit tests for openProfileWindow's failure reporting — no browser required.
 *
 * spawn() reports a missing or non-executable binary asynchronously, as an
 * 'error' event, not by throwing. When that event was ignored, a bad executable
 * path returned `ok` and the caller's 15s sentinel poll blamed the browser:
 * "couldn't open a window in <profile> automatically". These tests pin the
 * failure to its real cause instead.
 *
 * Run: npm test
 */
import { test, before, after, describe } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openProfileWindow } from "../../src/profile/launch";

describe("openProfileWindow's failure reporting", () => {
  let root: string;

  before(() => {
    root = mkdtempSync(join(tmpdir(), "pi-launch-"));
  });

  after(() => {
    rmSync(root, { recursive: true, force: true });
  });

  // L1: a nonexistent binary — the shape of an in-place browser upgrade,
  // where /proc/<pid>/exe still names the unlinked file.
  describe("L1", () => {
    const missing = (): string => join(root, "chrome (deleted)");

    test("L1: a missing executable fails the launch", async () => {
      const r = await openProfileWindow({ exePath: missing(), profileDir: "Default" });
      assert.ok(!r.success);
    });

    test("L1: the error names the path that could not be launched", async () => {
      const r = await openProfileWindow({ exePath: missing(), profileDir: "Default" });
      assert.ok(!r.success);
      assert.ok(r.error.includes(missing()));
    });

    test("L1: the error carries spawn's own cause", async () => {
      const r = await openProfileWindow({ exePath: missing(), profileDir: "Default" });
      assert.ok(!r.success);
      assert.ok(r.error.includes("ENOENT"));
    });
  });

  // L2: a file that exists but is not executable — same async 'error' path,
  // different errno (EACCES). Skipped where the check is meaningless.
  test(
    "L2: a non-executable file fails the launch",
    { skip: process.platform === "win32" || process.getuid?.() === 0 },
    async () => {
      const notExec = join(root, "not-executable");
      writeFileSync(notExec, "#!/bin/sh\n", { mode: 0o644 });
      const r = await openProfileWindow({ exePath: notExec, profileDir: "Default" });
      assert.ok(!r.success);
    },
  );

  // L3: a failed launch leaves no sentinel file behind. The caller only calls
  // cleanup() on the success path, so the failure path owns its own tidying.
  describe("L3", () => {
    let before_: string | undefined;

    before(() => {
      before_ = process.env["TMPDIR"];
      process.env["TMPDIR"] = root;
    });

    after(() => {
      if (before_ === undefined) delete process.env["TMPDIR"];
      else process.env["TMPDIR"] = before_;
    });

    test("L3: launch failed as set up", async () => {
      const r = await openProfileWindow({ exePath: join(root, "absent"), profileDir: "Default" });
      assert.ok(!r.success);
    });

    test("L3: no handshake page is left on disk after a failed launch", async () => {
      await openProfileWindow({ exePath: join(root, "absent"), profileDir: "Default" });
      const leftovers = readdirSync(root).filter((n) => n.startsWith("pi-harness-"));
      assert.equal(leftovers.length, 0);
    });
  });

  // L4: a launcher that starts succeeds, and the sentinel it advertises is a
  // real, readable file — the page the browser is asked to open.
  describe("L4", () => {
    let r: Awaited<ReturnType<typeof openProfileWindow>>;

    before(async () => {
      const stub = join(root, "stub-browser");
      writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      r = await openProfileWindow({ exePath: stub, profileDir: "Default" });
    });

    test("L4: a startable binary yields a handle", () => {
      assert.ok(r.success);
    });

    test("L4: the sentinel page exists before the browser is polled", () => {
      assert.ok(r.success);
      if (r.success) {
        const sentinel = fileURLToPath(r.data.sentinelUrl);
        assert.ok(existsSync(sentinel));
      }
    });

    test("L4: cleanup removes the sentinel page", async () => {
      assert.ok(r.success);
      if (r.success) {
        const sentinel = fileURLToPath(r.data.sentinelUrl);
        await r.data.cleanup();
        assert.ok(!existsSync(sentinel));
      }
    });

    test("L4: kill is safe to call twice", () => {
      assert.ok(r.success);
      if (r.success) {
        r.data.kill();
        r.data.kill();
      }
    });
  });
});
