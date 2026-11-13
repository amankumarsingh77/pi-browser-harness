import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { existsSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { setTimeout as sleep } from "node:timers/promises";
import { createIpcServer, isDaemonAlreadyRunning, type IpcServer } from "../../src/daemon/server";
import { probeSocket, startupLockPath } from "../../src/daemon/socket-claim";
import { isDaemonRunning } from "../../src/daemon/spawn";
import { createDaemon } from "../../src/daemon/index";
import { createCdpBridge } from "../../src/daemon/bridge";
import { cdpError } from "../../src/cdp/errors";
import { err } from "../../src/util/result";
import { deserialize, serialize, type WireMessage } from "../../src/daemon/protocol";
import { waitFor } from "../helpers/wait";

const SKIP = process.platform === "win32" ? "socket ownership is a filesystem concern; Windows uses named pipes" : false;
const fixture = join(dirname(fileURLToPath(import.meta.url)), "fixtures", "server-race-fixture.ts");

const withDir = async (fn: (socketPath: string) => Promise<void>): Promise<void> => {
  const dir = mkdtempSync(join(tmpdir(), "pbh-own-"));
  try {
    await fn(join(dir, "d.sock"));
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
};

type Client = { readonly socket: Socket; readonly received: WireMessage[] };

const register = (socketPath: string, clientId: string): Promise<Client> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const received: WireMessage[] = [];
    const rl = createInterface({ input: socket, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const msg = deserialize(line);
      if (!msg) return;
      received.push(msg);
      if (msg.type === "control" && msg.action === "registered") resolve({ socket, received });
    });
    socket.on("error", reject);
    socket.on("connect", () => {
      socket.write(serialize({ type: "control", action: "register", clientId }) + "\n");
    });
  });

const request = (client: Client): void => {
  client.socket.write(serialize({ type: "request", id: 1, method: "synthetic", params: {} }) + "\n");
};

const startRejection = async (server: IpcServer): Promise<unknown> => {
  try {
    await server.start();
    return undefined;
  } catch (e) {
    return e;
  }
};

type Contender = { readonly child: ChildProcessWithoutNullStreams; readonly outcome: Promise<string> };

const contend = (socketPath: string): Contender => {
  const child = spawn(process.execPath, ["--conditions=import", "--import", "tsx", fixture, socketPath], {
    stdio: ["pipe", "pipe", "pipe"],
  });
  let stderr = "";
  child.stderr.on("data", (c: Buffer) => { stderr += c.toString(); });
  const outcome = new Promise<string>((resolve) => {
    const rl = createInterface({ input: child.stdout, crlfDelay: Infinity });
    rl.once("line", (line) => { resolve(line); });
    child.once("exit", (code) => { resolve(`exited ${String(code)} without a verdict: ${stderr}`); });
  });
  return { child, outcome };
};

const exited = (c: Contender): Promise<void> =>
  new Promise((resolve) => {
    if (c.child.exitCode !== null || c.child.signalCode !== null) { resolve(); return; }
    c.child.once("exit", () => { resolve(); });
  });

// A socket file whose listener died without cleaning up, as a SIGKILLed daemon leaves behind.
const leaveStaleSocket = async (socketPath: string): Promise<void> => {
  const owner = contend(socketPath);
  assert.equal(await owner.outcome, "listening");
  owner.child.kill("SIGKILL");
  await exited(owner);
  assert.equal(existsSync(socketPath), true, "the killed owner should leave its socket file behind");
};

const silentServer = (socketPath: string): Promise<Server> =>
  new Promise((resolve) => {
    const held: Socket[] = [];
    const server = createServer((conn) => { held.push(conn); });
    server.on("close", () => { for (const c of held) c.destroy(); });
    server.listen(socketPath, () => { resolve(server); });
  });

const closeServer = (server: Server): Promise<void> =>
  new Promise((resolve) => {
    server.close(() => { resolve(); });
    server.emit("close");
  });

describe("daemon socket ownership", { skip: SKIP }, () => {
  test("a second server refuses a live socket and the first keeps every client, old and new", async () => {
    await withDir(async (socketPath) => {
      const a = createIpcServer({ socketPath });
      const b = createIpcServer({ socketPath });
      const seen: string[] = [];
      a.onMessage((_m, c) => { seen.push(`A:${c.id}`); });
      b.onMessage((_m, c) => { seen.push(`B:${c.id}`); });
      await a.start();
      const oldClient = await register(socketPath, "old");

      const rejection = await startRejection(b);
      assert.ok(isDaemonAlreadyRunning(rejection), `expected an already-running refusal, got ${String(rejection)}`);

      const newClient = await register(socketPath, "new");
      request(oldClient);
      request(newClient);
      assert.ok(await waitFor(() => seen.length === 2));
      assert.deepEqual([...seen].sort(), ["A:new", "A:old"]);

      oldClient.socket.destroy();
      newClient.socket.destroy();
      await a.stop();
    });
  });

  test("stopping a server that never got the socket leaves the owner's socket in place", async () => {
    await withDir(async (socketPath) => {
      const a = createIpcServer({ socketPath });
      const b = createIpcServer({ socketPath });
      await a.start();
      await startRejection(b);
      await b.stop();
      assert.equal(existsSync(socketPath), true);
      const client = await register(socketPath, "after-b-stop");
      client.socket.destroy();
      await a.stop();
    });
  });

  test("stop removes the socket the server owns", async () => {
    await withDir(async (socketPath) => {
      const a = createIpcServer({ socketPath });
      await a.start();
      assert.equal(existsSync(socketPath), true);
      await a.stop();
      assert.equal(existsSync(socketPath), false);
    });
  });

  test("a stale socket left by a killed daemon is reaped and the server starts", async () => {
    await withDir(async (socketPath) => {
      await leaveStaleSocket(socketPath);
      assert.equal(await probeSocket(socketPath), "stale");
      const server = createIpcServer({ socketPath });
      await server.start();
      const client = await register(socketPath, "c1");
      client.socket.destroy();
      await server.stop();
      assert.equal(existsSync(startupLockPath(socketPath)), false, "the startup lock must be released");
    });
  });

  test("a path that is not a socket is never deleted", async () => {
    await withDir(async (socketPath) => {
      writeFileSync(socketPath, "not a socket");
      const server = createIpcServer({ socketPath });
      const rejection = await startRejection(server);
      assert.ok(rejection instanceof Error);
      assert.equal(existsSync(socketPath), true);
      await server.stop();
      assert.equal(existsSync(socketPath), true);
    });
  });

  test("a startup lock abandoned by a crashed daemon is taken over", async () => {
    await withDir(async (socketPath) => {
      await leaveStaleSocket(socketPath);
      const lock = startupLockPath(socketPath);
      writeFileSync(lock, "999999");
      const longAgo = new Date(Date.now() - 60_000);
      utimesSync(lock, longAgo, longAgo);
      const server = createIpcServer({ socketPath });
      await server.start();
      await server.stop();
      assert.equal(existsSync(lock), false);
    });
  });

  test("a startup lock another daemon holds is waited for, not broken", async () => {
    await withDir(async (socketPath) => {
      await leaveStaleSocket(socketPath);
      const lock = startupLockPath(socketPath);
      writeFileSync(lock, "999999");
      const server = createIpcServer({ socketPath });
      let started = false;
      const starting = server.start().then(() => { started = true; });
      await sleep(200);
      assert.equal(started, false, "start must wait while the lock is held");
      assert.equal(existsSync(lock), true);
      rmSync(lock);
      await starting;
      await server.stop();
    });
  });
});

describe("daemon startup races across processes", { skip: SKIP }, () => {
  const race = async (socketPath: string, count: number): Promise<void> => {
    const contenders = Array.from({ length: count }, () => contend(socketPath));
    try {
      const outcomes = await Promise.all(contenders.map((c) => c.outcome));
      const winners = outcomes.filter((o) => o === "listening").length;
      const refused = outcomes.filter((o) => o === "refused").length;
      assert.equal(winners, 1, `exactly one contender may own the socket: ${outcomes.join(", ")}`);
      assert.equal(refused, count - 1, `every other contender must be refused: ${outcomes.join(", ")}`);
      const client = await register(socketPath, "after-race");
      request(client);
      assert.ok(await waitFor(() => client.received.some((m) => m.type === "response"), 2_000));
      client.socket.destroy();
    } finally {
      for (const c of contenders) c.child.stdin.end();
      await Promise.all(contenders.map(exited));
    }
  };

  test("of several daemons starting at once on a free path, exactly one owns the socket", async () => {
    await withDir(async (socketPath) => { await race(socketPath, 6); });
  });

  test("of several daemons starting at once over a stale socket, exactly one owns the socket", async () => {
    await withDir(async (socketPath) => {
      await leaveStaleSocket(socketPath);
      await race(socketPath, 6);
    });
  });
});

describe("client liveness probe", { skip: SKIP }, () => {
  test("a live daemon that is slow to answer is reported not ready, and its socket is left alone", async () => {
    await withDir(async (socketPath) => {
      const server = await silentServer(socketPath);
      try {
        assert.equal(await isDaemonRunning(100, socketPath), false);
        assert.equal(existsSync(socketPath), true, "the probe must not unlink a live socket");
        assert.equal(await probeSocket(socketPath), "live");
      } finally {
        await closeServer(server);
      }
    });
  });

  test("a stale socket is reported not running and left for the next daemon to reap", async () => {
    await withDir(async (socketPath) => {
      await leaveStaleSocket(socketPath);
      assert.equal(await isDaemonRunning(500, socketPath), false);
      await sleep(50);
      assert.equal(existsSync(socketPath), true);
    });
  });

  test("a running server answers the probe", async () => {
    await withDir(async (socketPath) => {
      const server = createIpcServer({ socketPath });
      await server.start();
      assert.equal(await isDaemonRunning(1_000, socketPath), true);
      await server.stop();
    });
  });
});

describe("daemon process when another daemon owns the socket", { skip: SKIP }, () => {
  test("it exits cleanly without dialing Chrome and without disturbing the owner", async () => {
    await withDir(async (socketPath) => {
      const owner = createIpcServer({ socketPath });
      await owner.start();
      const exits: number[] = [];
      const logged: string[] = [];
      let bridgeStarted = false;
      const bridge = createCdpBridge({
        discoverWsUrl: () => Promise.resolve(err(cdpError("discovery_failed", "no chrome in tests"))),
        connectTimeoutMs: 50,
      });
      const daemon = createDaemon({
        ipcServer: createIpcServer({ socketPath }),
        cdpBridge: { ...bridge, start: () => { bridgeStarted = true; return bridge.start(); } },
        exit: (code) => { exits.push(code); },
        log: (line) => { logged.push(line); },
      });
      await daemon.start();
      assert.deepEqual(exits, [0]);
      assert.equal(bridgeStarted, false);
      assert.ok(logged.some((m) => m.includes("already running")), logged.join(" | "));
      assert.equal(await isDaemonRunning(1_000, socketPath), true);
      await bridge.stop();
      await owner.stop();
    });
  });
});
