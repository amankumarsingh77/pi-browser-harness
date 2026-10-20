import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server, type Socket } from "node:net";
import { createInterface } from "node:readline";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDaemonTransport } from "../../src/daemon/transport";
import { deserialize, serialize, type WireControl } from "../../src/daemon/protocol";

const SKIP = process.platform === "win32" ? "the fake daemon listens on a temp socket file" : false;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

type FakeDaemon = {
  readonly socketPath: string;
  readonly connections: Socket[];
  readonly registers: string[];
  readonly dispose: () => Promise<void>;
};

// `onRegister` decides what the daemon answers; the default acks like the real one.
const startFakeDaemon = (
  onRegister: (conn: Socket, clientId: string) => void = (conn, clientId) => {
    const ack: WireControl = { type: "control", action: "registered", clientId };
    conn.write(serialize(ack) + "\n");
  },
): Promise<FakeDaemon> =>
  new Promise((resolve) => {
    const dir = mkdtempSync(join(tmpdir(), "pbh-transport-"));
    const socketPath = join(dir, "d.sock");
    const connections: Socket[] = [];
    const registers: string[] = [];
    const server: Server = createServer((conn) => {
      connections.push(conn);
      conn.on("error", () => undefined);
      const rl = createInterface({ input: conn, crlfDelay: Infinity });
      rl.on("line", (line) => {
        const msg = deserialize(line);
        if (msg?.type === "control" && msg.action === "register") {
          registers.push(msg.clientId);
          onRegister(conn, msg.clientId);
        }
      });
    });
    server.listen(socketPath, () => {
      resolve({
        socketPath,
        connections,
        registers,
        dispose: () =>
          new Promise((done) => {
            for (const c of connections) c.destroy();
            server.close(() => {
              rmSync(dir, { recursive: true, force: true });
              done();
            });
          }),
      });
    });
  });

describe("daemon transport", { skip: SKIP }, () => {
  test("a daemon that accepts but never registers makes connect() time out", async () => {
    const daemon = await startFakeDaemon(() => undefined);
    try {
      const transport = createDaemonTransport("client-a", daemon.socketPath);
      const started = Date.now();
      const r = await transport.connect("", { timeoutMs: 50 });
      assert.equal(r.success, false);
      assert.equal(r.error.kind, "timeout");
      assert.ok(Date.now() - started < 2_000, "connect() did not hang");
      assert.equal(transport.state(), "closed");
    } finally {
      await daemon.dispose();
    }
  });

  test("overlapping connect() calls share one handshake and one socket", async () => {
    const pendingAcks: Array<() => void> = [];
    const daemon = await startFakeDaemon((conn, clientId) => {
      pendingAcks.push(() => {
        const msg: WireControl = { type: "control", action: "registered", clientId };
        conn.write(serialize(msg) + "\n");
      });
    });
    try {
      const transport = createDaemonTransport("client-a", daemon.socketPath);
      const first = transport.connect("");
      const second = transport.connect("");
      await sleep(30);
      assert.equal(daemon.registers.length, 1, "exactly one register was sent");
      assert.equal(pendingAcks.length, 1, "daemon saw one handshake");
      pendingAcks[0]?.();

      const [r1, r2] = await Promise.all([first, second]);
      assert.equal(r1.success, true);
      assert.equal(r2.success, true);
      assert.equal(daemon.connections.length, 1, "only one socket was opened");
      assert.equal(transport.state(), "open");

      // Once registered, a further connect() is a no-op.
      const r3 = await transport.connect("");
      assert.equal(r3.success, true);
      assert.equal(daemon.connections.length, 1);
      await transport.close();
      assert.equal(transport.state(), "closed");
    } finally {
      await daemon.dispose();
    }
  });

  test("a shutdown reply before registration fails connect() and leaves the transport closed", async () => {
    const daemon = await startFakeDaemon((conn) => {
      const msg: WireControl = { type: "control", action: "shutdown", reason: "clientId is already connected" };
      conn.end(serialize(msg) + "\n");
    });
    try {
      const transport = createDaemonTransport("client-a", daemon.socketPath);
      const r = await transport.connect("", { timeoutMs: 500 });
      assert.equal(r.success, false);
      assert.match(r.error.message, /already connected/);
      assert.equal(transport.state(), "closed");
    } finally {
      await daemon.dispose();
    }
  });

  test("a missing socket path fails fast with a clear message", async () => {
    const transport = createDaemonTransport("client-a", join(tmpdir(), "pbh-no-such-daemon.sock"));
    const r = await transport.connect("", { timeoutMs: 500 });
    assert.equal(r.success, false);
    assert.match(r.error.message, /not running/);
    assert.equal(transport.state(), "closed");
  });

  test("close() tears the transport down and notifies close listeners once", async () => {
    const daemon = await startFakeDaemon();
    try {
      const transport = createDaemonTransport("client-a", daemon.socketPath);
      let closes = 0;
      transport.onClose(() => { closes += 1; });
      const r = await transport.connect("");
      assert.equal(r.success, true);
      await transport.close();
      await sleep(20);
      assert.equal(closes, 1);
      assert.equal(transport.state(), "closed");
    } finally {
      await daemon.dispose();
    }
  });
});
