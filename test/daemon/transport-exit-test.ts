import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "transport-exit-fixture.ts");
const SKIP = process.platform === "win32" ? "named pipes are not filesystem paths; the fixture uses a temp socket file" : false;

describe("daemon transport and process exit", { skip: SKIP }, () => {
  test("a connected transport does not keep the process alive once nothing else is pending", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pbh-exit-"));
    const socketPath = join(dir, "d.sock");
    try {
      const child = spawn(process.execPath, ["--conditions=import", "--import", "tsx", fixture, socketPath], {
        stdio: ["ignore", "pipe", "pipe"],
      });
      let stdout = "";
      let stderr = "";
      child.stdout.on("data", (c: Buffer) => { stdout += c.toString(); });
      child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });

      const outcome = await new Promise<"exited" | "hung">((resolve) => {
        const timer = setTimeout(() => { child.kill("SIGKILL"); resolve("hung"); }, 15_000);
        child.on("exit", () => { clearTimeout(timer); resolve("exited"); });
      });

      assert.match(stdout, /^connected/m, `fixture did not connect: ${stderr}`);
      assert.equal(outcome, "exited", "process stayed alive after the transport connected: pi -p would never exit");
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
