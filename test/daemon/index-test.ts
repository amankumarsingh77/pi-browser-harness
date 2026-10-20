import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createDaemon, type Daemon } from "../../src/daemon/index";
import { createIpcServer, type IpcServer } from "../../src/daemon/server";
import { createCdpBridge, type CdpBridge } from "../../src/daemon/bridge";
import { cdpError } from "../../src/cdp/errors";
import { err } from "../../src/util/result";
import { deserialize, serialize, type WireMessage } from "../../src/daemon/protocol";
import { waitFor } from "../helpers/wait";

// src/daemon/index.ts only exports the composition (the process entry is main.ts), so it can be
// imported here and createDaemon driven over a temp socket. Chrome is never
// reachable: the bridge's discovery is stubbed to fail fast, so every forwarded request is answered
// with the bridge's "Chrome not connected" error instead of a socket attempt.

const SKIP = process.platform === "win32" ? "the fixture server listens on a temp socket file" : false;

type Harness = {
  readonly daemon: Daemon;
  readonly ipcServer: IpcServer;
  readonly cdpBridge: CdpBridge;
  readonly socketPath: string;
  readonly removed: ReadonlyArray<string>;
  readonly exits: ReadonlyArray<number>;
  readonly logged: ReadonlyArray<string>;
  readonly dispose: () => Promise<void>;
};

const startDaemon = async (idleTimeoutMs: number): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), "pbh-daemon-"));
  const socketPath = join(dir, "d.sock");
  const ipcServer = createIpcServer({ socketPath, maxClients: 4 });
  const cdpBridge = createCdpBridge({
    discoverWsUrl: () => Promise.resolve(err(cdpError("discovery_failed", "no chrome in tests"))),
    connectTimeoutMs: 50,
  });
  const removed: string[] = [];
  const realRemove = cdpBridge.removeClient;
  const spiedBridge: CdpBridge = {
    ...cdpBridge,
    removeClient: (clientId) => {
      removed.push(clientId);
      realRemove(clientId);
    },
  };
  const exits: number[] = [];
  const logged: string[] = [];
  const daemon = createDaemon({
    ipcServer,
    cdpBridge: spiedBridge,
    idleTimeoutMs,
    exit: (code) => { exits.push(code); },
    log: (line) => { logged.push(line); },
  });
  await daemon.start();
  return {
    daemon,
    ipcServer,
    cdpBridge,
    socketPath,
    removed,
    exits,
    logged,
    dispose: async () => {
      await daemon.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

type Client = {
  readonly socket: Socket;
  readonly received: WireMessage[];
  readonly closed: () => boolean;
  readonly send: (msg: WireMessage) => void;
};

const dial = (socketPath: string): Promise<Client> =>
  new Promise((resolve, reject) => {
    const socket = createConnection(socketPath);
    const received: WireMessage[] = [];
    let closed = false;
    const rl = createInterface({ input: socket, crlfDelay: Infinity });
    rl.on("line", (line) => {
      const msg = deserialize(line);
      if (msg) received.push(msg);
    });
    socket.on("close", () => { closed = true; });
    socket.on("error", (e) => { reject(e); });
    socket.on("connect", () => {
      resolve({
        socket,
        received,
        closed: () => closed,
        send: (msg) => { socket.write(serialize(msg) + "\n"); },
      });
    });
  });

const register = async (socketPath: string, clientId: string): Promise<Client> => {
  const client = await dial(socketPath);
  client.send({ type: "control", action: "register", clientId });
  const acked = await waitFor(() =>
    client.received.some((m) => m.type === "control" && m.action === "registered" && m.clientId === clientId),
  );
  assert.ok(acked, `${clientId} was not acknowledged`);
  return client;
};

describe("createDaemon (ipc server + cdp bridge)", { skip: SKIP }, () => {
  test("start listens, connects the bridge and arms the idle timer with no clients", async () => {
    const d = await startDaemon(60_000);
    try {
      assert.ok(d.logged.includes("IPC server listening"));
      assert.equal(d.daemon.idleTimerArmed(), true);
      assert.equal(d.cdpBridge.isAlive(), false);
      assert.deepEqual(d.exits, []);
    } finally {
      await d.dispose();
    }
  });

  test("a registered client's request is forwarded to the bridge and answered on its own socket with its own id", async () => {
    const d = await startDaemon(60_000);
    try {
      const a = await register(d.socketPath, "client-a");
      const b = await register(d.socketPath, "client-b");
      a.send({ type: "request", id: 7, method: "Browser.getVersion" });
      const answered = await waitFor(() => a.received.some((m) => m.type === "response" && m.id === 7));
      assert.ok(answered, "client-a never got a response");
      const response = a.received.find((m) => m.type === "response");
      assert.ok(response);
      assert.match(response.error?.message ?? "", /Chrome not connected/);
      assert.equal(b.received.some((m) => m.type === "response"), false, "the other client must not see it");
      assert.equal(d.cdpBridge.isAlive(), false);
      a.socket.destroy();
      b.socket.destroy();
    } finally {
      await d.dispose();
    }
  });

  test("control messages never reach the bridge, so an unregistered socket's request is dropped", async () => {
    const d = await startDaemon(60_000);
    try {
      const anon = await dial(d.socketPath);
      anon.send({ type: "request", id: 1, method: "Browser.getVersion" });
      await sleep(50);
      assert.equal(anon.received.length, 0);
      anon.socket.destroy();
    } finally {
      await d.dispose();
    }
  });

  test("a client that deregisters or drops its socket is removed from the bridge", async () => {
    const d = await startDaemon(60_000);
    try {
      const a = await register(d.socketPath, "client-a");
      const b = await register(d.socketPath, "client-b");
      a.send({ type: "control", action: "deregister", clientId: "client-a" });
      assert.ok(await waitFor(() => d.removed.includes("client-a")));
      b.socket.destroy();
      assert.ok(await waitFor(() => d.removed.includes("client-b")));
      assert.deepEqual(d.removed, ["client-a", "client-b"]);
      assert.equal(d.ipcServer.clientCount(), 0);
    } finally {
      await d.dispose();
    }
  });

  test("the idle timer is cancelled by a connect, re-armed by the last disconnect, and shuts the daemon down when it fires", async () => {
    const d = await startDaemon(40);
    try {
      const a = await register(d.socketPath, "client-a");
      assert.equal(d.daemon.idleTimerArmed(), false, "a connected client disarms the timer");
      a.socket.destroy();
      assert.ok(await waitFor(() => d.daemon.idleTimerArmed()));
      // A new client inside the idle window disarms the timer again.
      const b = await register(d.socketPath, "client-b");
      await sleep(80);
      assert.deepEqual(d.exits, [], "the timer must be cancelled by a connect");
      b.socket.destroy();
      assert.ok(await waitFor(() => d.exits.length === 1, 500), "the timer fires once the daemon is idle again");
      assert.deepEqual(d.exits, [0]);
      assert.ok(d.logged.some((m) => m.includes("Idle timeout")));
      assert.ok(d.logged.includes("Shutting down..."));
      assert.equal(d.ipcServer.socketCount(), 0, "shutdown closed the socket");
    } finally {
      await d.dispose();
    }
  });

  test("the idle timer does not arm while another client is still registered", async () => {
    const d = await startDaemon(30);
    try {
      const a = await register(d.socketPath, "client-a");
      const b = await register(d.socketPath, "client-b");
      a.socket.destroy();
      await sleep(80);
      assert.deepEqual(d.exits, []);
      assert.equal(d.daemon.idleTimerArmed(), false);
      assert.equal(d.ipcServer.clientCount(), 1);
      b.socket.destroy();
    } finally {
      await d.dispose();
    }
  });

  test("stop closes the socket, exits once, and is idempotent", async () => {
    const d = await startDaemon(60_000);
    const a = await register(d.socketPath, "client-a");
    await d.daemon.stop();
    await d.daemon.stop();
    assert.ok(await waitFor(() => a.closed()), "the client socket is closed by the server");
    assert.equal(d.ipcServer.socketCount(), 0);
    assert.equal(d.ipcServer.clientCount(), 0);
    assert.deepEqual(d.exits, [0]);
    assert.equal(d.daemon.idleTimerArmed(), false);
    await d.dispose();
  });

  test("a socket that cannot be bound exits with code 1 without touching the bridge", async () => {
    const dir = mkdtempSync(join(tmpdir(), "pbh-daemon-"));
    const exits: number[] = [];
    const logged: string[] = [];
    let bridgeStarted = false;
    const bridge = createCdpBridge({
      discoverWsUrl: () => Promise.resolve(err(cdpError("discovery_failed", "no chrome in tests"))),
      connectTimeoutMs: 50,
    });
    const spiedBridge: CdpBridge = { ...bridge, start: () => { bridgeStarted = true; return bridge.start(); } };
    const daemon = createDaemon({
      // The parent directory of the socket does not exist, so listen() rejects.
      ipcServer: createIpcServer({ socketPath: join(dir, "missing", "d.sock") }),
      cdpBridge: spiedBridge,
      exit: (code) => { exits.push(code); },
      log: (line) => { logged.push(line); },
    });
    try {
      await daemon.start();
      assert.deepEqual(exits, [1]);
      assert.equal(bridgeStarted, false);
      assert.ok(logged.some((m) => m.includes("Failed to start IPC server")));
      assert.equal(daemon.idleTimerArmed(), false);
    } finally {
      await bridge.stop();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
