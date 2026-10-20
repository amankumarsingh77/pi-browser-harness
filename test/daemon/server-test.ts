import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createConnection, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { setTimeout as sleep } from "node:timers/promises";
import { createIpcServer, type IpcServer } from "../../src/daemon/server";
import { deserialize, serialize, type WireControl, type WireMessage } from "../../src/daemon/protocol";
import { waitFor } from "../helpers/wait";

const SKIP = process.platform === "win32" ? "the fixture server listens on a temp socket file" : false;

type Harness = {
  readonly server: IpcServer;
  readonly socketPath: string;
  readonly dispose: () => Promise<void>;
};

const startServer = async (maxClients?: number): Promise<Harness> => {
  const dir = mkdtempSync(join(tmpdir(), "pbh-server-"));
  const socketPath = join(dir, "d.sock");
  const server = createIpcServer({ socketPath, ...(maxClients !== undefined ? { maxClients } : {}) });
  await server.start();
  return {
    server,
    socketPath,
    dispose: async () => {
      await server.stop();
      rmSync(dir, { recursive: true, force: true });
    },
  };
};

type Client = {
  readonly socket: Socket;
  readonly received: WireMessage[];
  readonly closed: () => boolean;
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
    socket.on("connect", () => { resolve({ socket, received, closed: () => closed }); });
  });

const send = (client: Client, msg: WireControl): void => {
  client.socket.write(serialize(msg) + "\n");
};

const register = async (socketPath: string, clientId: string): Promise<Client> => {
  const client = await dial(socketPath);
  send(client, { type: "control", action: "register", clientId });
  const acked = await waitFor(() =>
    client.received.some((m) => m.type === "control" && m.action === "registered" && m.clientId === clientId),
  );
  assert.ok(acked, `${clientId} was not acknowledged`);
  return client;
};

describe("daemon ipc server", { skip: SKIP }, () => {
  test("every registered disconnect handler runs, and a disposed one does not", async () => {
    const h = await startServer();
    try {
      const seen: string[] = [];
      h.server.onDisconnect((c) => { seen.push(`first:${c.id}`); });
      const disposeSecond = h.server.onDisconnect((c) => { seen.push(`second:${c.id}`); });
      h.server.onDisconnect((c) => { seen.push(`third:${c.id}`); });
      disposeSecond();

      const client = await register(h.socketPath, "client-a");
      client.socket.destroy();

      assert.ok(await waitFor(() => seen.length >= 2), "disconnect handlers ran");
      assert.deepEqual(seen.sort(), ["first:client-a", "third:client-a"]);
      assert.equal(h.server.clientCount(), 0);
    } finally {
      await h.dispose();
    }
  });

  test("deregister drops the client and runs the disconnect handlers before the socket closes", async () => {
    const h = await startServer();
    try {
      const gone: string[] = [];
      h.server.onDisconnect((c) => { gone.push(c.id); });

      const client = await register(h.socketPath, "client-a");
      assert.equal(h.server.clientCount(), 1);

      send(client, { type: "control", action: "deregister", clientId: "client-a" });
      assert.ok(await waitFor(() => gone.length === 1), "disconnect handler ran on deregister");
      assert.equal(h.server.clientCount(), 0);

      // The later socket close must not report the same client twice.
      assert.ok(await waitFor(() => client.closed()), "server ended the deregistered socket");
      await sleep(10);
      assert.deepEqual(gone, ["client-a"]);

      // The id is free again at once.
      const again = await register(h.socketPath, "client-a");
      assert.equal(h.server.clientCount(), 1);
      again.socket.destroy();
    } finally {
      await h.dispose();
    }
  });

  test("a deregister naming another client is ignored", async () => {
    const h = await startServer();
    try {
      const gone: string[] = [];
      h.server.onDisconnect((c) => { gone.push(c.id); });
      const a = await register(h.socketPath, "client-a");
      const b = await register(h.socketPath, "client-b");

      send(a, { type: "control", action: "deregister", clientId: "client-b" });
      await sleep(20);
      assert.deepEqual(gone, []);
      assert.equal(h.server.clientCount(), 2);

      a.socket.destroy();
      b.socket.destroy();
    } finally {
      await h.dispose();
    }
  });

  test("a duplicate clientId receives the shutdown reply before its socket closes", async () => {
    const h = await startServer();
    try {
      const first = await register(h.socketPath, "client-a");
      const dup = await dial(h.socketPath);
      send(dup, { type: "control", action: "register", clientId: "client-a" });

      assert.ok(await waitFor(() => dup.closed()), "duplicate socket was closed");
      const reply = dup.received.find((m) => m.type === "control" && m.action === "shutdown");
      assert.ok(reply, "shutdown reply was delivered");
      assert.match(reply.reason ?? "", /already connected/);

      assert.equal(h.server.clientCount(), 1, "the original registration survives");
      assert.ok(!first.closed(), "the original socket stays open");
      first.socket.destroy();
    } finally {
      await h.dispose();
    }
  });

  test("the connection cap counts sockets that have not registered yet", async () => {
    const h = await startServer(2);
    try {
      const anon1 = await dial(h.socketPath);
      const anon2 = await dial(h.socketPath);
      assert.ok(await waitFor(() => h.server.socketCount() === 2), "two anonymous sockets are held");

      const third = await dial(h.socketPath);
      assert.ok(await waitFor(() => third.closed()), "a third socket is refused while two anonymous ones are open");
      assert.equal(h.server.clientCount(), 0);

      anon1.socket.destroy();
      anon2.socket.destroy();
      assert.ok(await waitFor(() => h.server.socketCount() === 0), "closed sockets free their slots");

      const later = await register(h.socketPath, "client-late");
      assert.equal(h.server.clientCount(), 1);
      later.socket.destroy();
    } finally {
      await h.dispose();
    }
  });

  test("messages only reach the handler from registered clients, and only requests are forwarded", async () => {
    const h = await startServer();
    try {
      const seen: string[] = [];
      h.server.onMessage((msg, c) => { seen.push(`${c.id}:${msg.type}`); });

      const anon = await dial(h.socketPath);
      anon.socket.write(serialize({ type: "request", id: 1, method: "Runtime.enable" }) + "\n");
      const client = await register(h.socketPath, "client-a");
      client.socket.write(serialize({ type: "request", id: 1, method: "Runtime.enable" }) + "\n");

      assert.ok(await waitFor(() => seen.length === 1), "one message was handled");
      assert.deepEqual(seen, ["client-a:request"]);
      anon.socket.destroy();
      client.socket.destroy();
    } finally {
      await h.dispose();
    }
  });
});
