import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Socket } from "node:net";
import { readLines } from "../../src/daemon/lines";

// A Socket that is never connected still emits "data"/"end"/"error" when told to, which is all the reader uses.
const fakeSocket = (): Socket => new Socket();

describe("daemon line reader", () => {
  test("reassembles lines across chunks and strips CR", () => {
    const sock = fakeSocket();
    const lines: string[] = [];
    readLines(sock, (l) => lines.push(l));
    sock.emit("data", Buffer.from('{"a":1}\n{"b"'));
    sock.emit("data", Buffer.from(':2}\r\n'));
    sock.emit("data", Buffer.from("tail"));
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}']);
    sock.emit("end");
    assert.deepEqual(lines, ['{"a":1}', '{"b":2}', "tail"]);
  });

  test("a socket error is not re-emitted anywhere; only the socket's own listener sees it", () => {
    const sock = fakeSocket();
    const seen: string[] = [];
    sock.on("error", (e: Error) => seen.push(e.message));
    readLines(sock, () => assert.fail("no line expected"));
    // node:readline would have re-thrown this as an unhandled "error" on its Interface.
    sock.emit("error", new Error("read ECONNRESET"));
    assert.deepEqual(seen, ["read ECONNRESET"]);
  });

  test("the disposer stops delivery, including a buffered partial line", () => {
    const sock = fakeSocket();
    const lines: string[] = [];
    const stop = readLines(sock, (l) => lines.push(l));
    sock.emit("data", Buffer.from("one\npart"));
    stop();
    sock.emit("data", Buffer.from("ial\n"));
    sock.emit("end");
    assert.deepEqual(lines, ["one"]);
  });
});
