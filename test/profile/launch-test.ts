/**
 * Unit tests for openProfileWindow's failure reporting — no browser required.
 *
 * spawn() reports a missing or non-executable binary asynchronously, as an
 * 'error' event, not by throwing. When that event was ignored, a bad executable
 * path returned `ok` and the caller's 15s sentinel poll blamed the browser:
 * "couldn't open a window in <profile> automatically". These tests pin the
 * failure to its real cause instead.
 *
 * Run: npx tsx test/profile/launch-test.ts
 */
import { existsSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { openProfileWindow } from "../../src/profile/launch";

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string): void => {
  if (cond) {
    passed++;
    console.log(`  ✓ ${label}`);
  } else {
    failed++;
    console.error(`  ✗ ${label}`);
  }
};

async function main(): Promise<void> {
  const root = mkdtempSync(join(tmpdir(), "pi-launch-"));
  try {
    // L1: a nonexistent binary — the shape of an in-place browser upgrade,
    // where /proc/<pid>/exe still names the unlinked file.
    {
      const missing = join(root, "chrome (deleted)");
      const r = await openProfileWindow({ exePath: missing, profileDir: "Default" });
      check(!r.success, "L1: a missing executable fails the launch");
      if (!r.success) {
        check(r.error.includes(missing), "L1: the error names the path that could not be launched");
        check(r.error.includes("ENOENT"), "L1: the error carries spawn's own cause");
      }
    }

    // L2: a file that exists but is not executable — same async 'error' path,
    // different errno (EACCES). Skipped where the check is meaningless.
    if (process.platform !== "win32" && process.getuid?.() !== 0) {
      const notExec = join(root, "not-executable");
      writeFileSync(notExec, "#!/bin/sh\n", { mode: 0o644 });
      const r = await openProfileWindow({ exePath: notExec, profileDir: "Default" });
      check(!r.success, "L2: a non-executable file fails the launch");
    }

    // L3: a failed launch leaves no sentinel file behind. The caller only calls
    // cleanup() on the success path, so the failure path owns its own tidying.
    {
      const before = process.env["TMPDIR"];
      process.env["TMPDIR"] = root;
      try {
        const r = await openProfileWindow({ exePath: join(root, "absent"), profileDir: "Default" });
        check(!r.success, "L3: launch failed as set up");
        const leftovers = readdirSync(root).filter((n) => n.startsWith("pi-harness-"));
        check(leftovers.length === 0, "L3: no handshake page is left on disk after a failed launch");
      } finally {
        if (before === undefined) delete process.env["TMPDIR"];
        else process.env["TMPDIR"] = before;
      }
    }

    // L4: a launcher that starts succeeds, and the sentinel it advertises is a
    // real, readable file — the page the browser is asked to open.
    {
      const stub = join(root, "stub-browser");
      writeFileSync(stub, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
      const r = await openProfileWindow({ exePath: stub, profileDir: "Default" });
      check(r.success, "L4: a startable binary yields a handle");
      if (r.success) {
        const sentinel = fileURLToPath(r.data.sentinelUrl);
        check(existsSync(sentinel), "L4: the sentinel page exists before the browser is polled");
        await r.data.cleanup();
        check(!existsSync(sentinel), "L4: cleanup removes the sentinel page");
        r.data.kill();
        r.data.kill();
        check(true, "L4: kill is safe to call twice");
      }
    }
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

void main();
