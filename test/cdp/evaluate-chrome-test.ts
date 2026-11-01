import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcess } from "node:child_process";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { evaluateParams } from "../../src/client";
import { isRecord } from "../../src/util/guards";

// The mocked CDP tests cannot show how Chrome itself treats these params: REPL mode once left an async body's
// promise unawaited and every top-level `return` came back as {}. These run the params against a real headless
// Chrome, and skip when none is installed.
const CANDIDATES = [
  process.env["CHROME_PATH"],
  "/usr/bin/google-chrome",
  "/usr/bin/google-chrome-stable",
  "/usr/bin/chromium",
  "/usr/bin/chromium-browser",
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
];
const chromePath = CANDIDATES.find((p): p is string => p !== undefined && p !== "" && existsSync(p));

type Page = { readonly evaluate: (expression: string) => Promise<unknown>; readonly close: () => void };

const openPage = async (port: number): Promise<Page> => {
  const targets: unknown = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
  const list: ReadonlyArray<unknown> = Array.isArray(targets) ? targets : [];
  const page = list.find((t) => isRecord(t) && t["type"] === "page");
  const wsUrl = isRecord(page) ? page["webSocketDebuggerUrl"] : undefined;
  if (typeof wsUrl !== "string") throw new Error("no page target");
  const ws = new WebSocket(wsUrl);
  await new Promise((resolve, reject) => {
    ws.onopen = resolve;
    ws.onerror = reject;
  });
  let id = 0;
  return {
    evaluate: (expression) =>
      new Promise((resolve) => {
        const callId = ++id;
        ws.addEventListener("message", (e) => {
          const msg: unknown = JSON.parse(String(e.data));
          if (!isRecord(msg) || msg["id"] !== callId) return;
          const result = isRecord(msg["result"]) ? msg["result"]["result"] : undefined;
          resolve(isRecord(result) ? result["value"] : undefined);
        });
        ws.send(JSON.stringify({ id: callId, method: "Runtime.evaluate", params: evaluateParams(expression) }));
      }),
    close: () => {
      ws.close();
    },
  };
};

const devtoolsPort = (chrome: ChildProcess): Promise<number> =>
  new Promise((resolve, reject) => {
    let buf = "";
    const timer = setTimeout(() => {
      reject(new Error("Chrome did not report a DevTools port"));
    }, 15_000);
    chrome.stderr?.on("data", (chunk: Buffer) => {
      buf += chunk.toString();
      const m = /DevTools listening on ws:\/\/[^:]+:(\d+)\//.exec(buf);
      if (m?.[1] !== undefined) {
        clearTimeout(timer);
        resolve(Number(m[1]));
      }
    });
  });

describe("Runtime.evaluate params against real Chrome", { skip: chromePath === undefined ? "no Chrome installed" : false }, () => {
  let chrome: ChildProcess | undefined;
  let profile = "";
  let page: Page | undefined;

  before(async () => {
    profile = mkdtempSync(join(tmpdir(), "pbh-eval-"));
    chrome = spawn(chromePath ?? "", ["--headless=new", "--remote-debugging-port=0", `--user-data-dir=${profile}`, "--no-first-run", "about:blank"], {
      stdio: ["ignore", "ignore", "pipe"],
    });
    page = await openPage(await devtoolsPort(chrome));
  });

  // Chrome keeps writing its profile until it exits, so the folder is removed only after that.
  after(async () => {
    page?.close();
    const proc = chrome;
    if (proc?.exitCode === null) {
      const exited = new Promise((resolve) => proc.once("exit", resolve));
      proc.kill();
      await exited;
    }
    rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  });

  const run = (src: string): Promise<unknown> => {
    if (page === undefined) throw new Error("page not open");
    return page.evaluate(src);
  };

  test("a body with a top-level return yields the returned value, not an unresolved promise", async () => {
    assert.equal(await run("const t = 'a'; return JSON.stringify({ t })"), '{"t":"a"}');
  });

  test("a top-level await before the return is awaited", async () => {
    assert.equal(await run("const v = await Promise.resolve(2); return v * 3"), 6);
  });

  test("a plain expression yields its value", async () => {
    assert.equal(await run("1 + 1"), 2);
  });

  test("a later call may declare the same const again", async () => {
    assert.equal(await run("const same = 1; same"), 1);
    assert.equal(await run("const same = 2; same"), 2);
  });
});
