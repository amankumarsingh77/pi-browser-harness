import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

const indexSource = await readFile(new URL("../src/index.ts", import.meta.url), "utf8");

function extractSessionStartHandler(source) {
  const marker = 'pi.on("session_start", async';
  const start = source.indexOf(marker);
  assert.notEqual(start, -1, "session_start handler should exist");

  const shutdownMarker = 'pi.on("session_shutdown"';
  const end = source.indexOf(shutdownMarker, start);
  assert.notEqual(end, -1, "session_shutdown handler should follow session_start");

  return source.slice(start, end);
}

test("session_start registers browser harness without starting Chrome", () => {
  const sessionStartHandler = extractSessionStartHandler(indexSource);

  assert.equal(
    sessionStartHandler.includes("client.start()"),
    false,
    "session_start must not call client.start(); browser connection should be lazy until a browser tool or /browser-setup is used",
  );
});
