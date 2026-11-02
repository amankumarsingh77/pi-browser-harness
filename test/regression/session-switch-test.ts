import assert from "node:assert/strict";
import { spawn, spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createInterface } from "node:readline";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { ALL_TOOLS } from "../../src/registry";
import { isRecord } from "../../src/util/guards";

// This is an integration regression: it drives the installed pi binary through two session
// runtimes in one process, loading this checkout's extension rather than the installed npm
// package (`--no-extensions` + an explicit `-e`). The unit tests cover the registration
// bookkeeping; this one proves the real extension factory/runtime path re-registers tools.
const hasPi = spawnSync("pi", ["--version"], { encoding: "utf8" }).status === 0;
const repoRoot = fileURLToPath(new URL("../../", import.meta.url));
const extensionPath = fileURLToPath(new URL("../../src/index.ts", import.meta.url));
const expectedBrowserTools = ALL_TOOLS.filter((tool) => tool.name.startsWith("browser_")).length;

const waitFor = async (predicate: () => boolean, timeoutMs: number, onTimeout: () => string): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error(onTimeout());
};

type RpcResponse = Readonly<Record<string, unknown>>;

test("switch_session keeps the full browser tool list in the new runtime", { skip: !hasPi }, async (t) => {
  assert.ok(existsSync(extensionPath), `extension source is missing: ${extensionPath}`);
  assert.ok(extensionPath.startsWith(repoRoot), "the integration test must load this checkout");
  assert.ok(!extensionPath.includes("/node_modules/"), "the integration test must not load the npm package");

  const dir = mkdtempSync(join(tmpdir(), "bh-session-switch-"));
  const eventsPath = join(dir, "events.jsonl");
  const sessionHeader = (id: string): string =>
    `${JSON.stringify({ type: "session", version: 3, id, timestamp: new Date().toISOString(), cwd: dir })}\n`;
  const loggerPath = join(dir, "logger.ts");

  writeFileSync(join(dir, "a.jsonl"), sessionHeader("01a00000-0000-7000-8000-000000000001"));
  writeFileSync(join(dir, "b.jsonl"), sessionHeader("01a00000-0000-7000-8000-000000000002"));
  writeFileSync(
    loggerPath,
    `import fs from "node:fs";
const out = process.env.BH_TEST_EVENTS;
export default function (pi) {
  pi.on("before_agent_start", () => {
    let active = [];
    try { active = pi.getActiveTools(); } catch {}
    fs.appendFileSync(out, JSON.stringify({ event: "before_agent_start", browser: active.filter((name) => name.startsWith("browser_")).length }) + "\\n");
  });
}
`,
  );

  const child = spawn(
    "pi",
    [
      "--mode",
      "rpc",
      "--session",
      join(dir, "a.jsonl"),
      "--offline",
      "--no-extensions",
      "-e",
      extensionPath,
      "-e",
      loggerPath,
    ],
    { cwd: dir, env: { ...process.env, BH_TEST_EVENTS: eventsPath }, stdio: ["pipe", "pipe", "pipe"] },
  );
  let stderr = "";
  child.stderr.on("data", (chunk) => {
    stderr += String(chunk);
  });

  const responseWaiters = new Map<string, (message: RpcResponse) => void>();
  const rl = createInterface({ input: child.stdout });
  rl.on("line", (line) => {
    try {
      const message: unknown = JSON.parse(line);
      if (!isRecord(message)) return;
      const id = message["id"];
      if (message["type"] === "response" && typeof id === "string") responseWaiters.get(id)?.(message);
    } catch {
      // Extension UI events and other non-JSON lines are not part of this test.
    }
  });

  const send = (message: object): void => {
    child.stdin.write(`${JSON.stringify(message)}\n`);
  };
  const waitForResponse = async (id: string): Promise<RpcResponse> => {
    return new Promise<RpcResponse>((resolve, reject) => {
      const timer = setTimeout(() => {
        responseWaiters.delete(id);
        reject(new Error(`no RPC response for ${id}${stderr ? `; stderr: ${stderr}` : ""}`));
      }, 15_000);
      responseWaiters.set(id, (message) => {
        clearTimeout(timer);
        responseWaiters.delete(id);
        resolve(message);
      });
    });
  };

  t.after(() => {
    rl.close();
    child.kill("SIGTERM");
    rmSync(dir, { recursive: true, force: true });
  });

  send({ id: "1", type: "get_state" });
  const initial = await waitForResponse("1");
  assert.equal(initial["success"], true, "get_state failed");

  send({ id: "2", type: "switch_session", sessionPath: join(dir, "b.jsonl") });
  const switched = await waitForResponse("2");
  assert.equal(switched["success"], true, "switch_session failed");
  const switchData = switched["data"];
  assert.ok(isRecord(switchData), "switch_session returned no data");
  assert.equal(switchData["cancelled"], false, "switch_session was cancelled");

  send({ id: "3", type: "prompt", message: "Reply with exactly OK" });
  const prompted = await waitForResponse("3");
  assert.equal(prompted["success"], true, "prompt was not accepted");

  await waitFor(
    () => existsSync(eventsPath) && readFileSync(eventsPath, "utf8").includes("before_agent_start"),
    30_000,
    () => `pi did not reach before_agent_start after switch_session${stderr ? `; stderr: ${stderr}` : ""}`,
  );

  const events = readFileSync(eventsPath, "utf8")
    .trim()
    .split("\n")
    .flatMap((line) => {
      const event: unknown = JSON.parse(line);
      if (!isRecord(event)) return [];
      const name = event["event"];
      const browser = event["browser"];
      return typeof name === "string" && typeof browser === "number" ? [{ event: name, browser }] : [];
    });
  const started = events.find((event) => event.event === "before_agent_start");

  assert.ok(started, "before_agent_start event was not recorded");
  assert.equal(started.browser, expectedBrowserTools, "the new runtime did not register all browser tools");
});
