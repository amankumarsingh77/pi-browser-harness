import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { endpointFromEnv, firstReadyPort, parseVersionResponse, probeEndpoint, type PortProbe, type ProbeDeps } from "../../src/cdp/discovery";
import { err, ok } from "../../src/util/result";
import { cdpError } from "../../src/cdp/errors";

describe("BU_CDP_WS endpoint override", () => {
  test("an unset variable leaves discovery to run normally", () => {
    assert.equal(endpointFromEnv({}), undefined);
  });

  test("a set variable becomes the endpoint", () => {
    const e = endpointFromEnv({ BU_CDP_WS: "ws://127.0.0.1:9333/devtools/browser/abc" });
    assert.equal(e?.wsUrl, "ws://127.0.0.1:9333/devtools/browser/abc");
  });

  test("no userDataDir is claimed for a remote endpoint", () => {
    const e = endpointFromEnv({ BU_CDP_WS: "ws://example.test/x" });
    assert.equal(e?.userDataDir, undefined);
  });

  test("surrounding whitespace is trimmed", () => {
    const e = endpointFromEnv({ BU_CDP_WS: "  ws://127.0.0.1:9222/x  " });
    assert.equal(e?.wsUrl, "ws://127.0.0.1:9222/x");
  });

  test("an empty or whitespace-only variable is ignored, not treated as an endpoint", () => {
    assert.equal(endpointFromEnv({ BU_CDP_WS: "" }), undefined);
    assert.equal(endpointFromEnv({ BU_CDP_WS: "   " }), undefined);
  });
});

describe("/json/version parsing", () => {
  test("extracts webSocketDebuggerUrl from a well-formed response", () => {
    const raw = JSON.stringify({ Browser: "Chrome/154.0", webSocketDebuggerUrl: "ws://127.0.0.1:9222/devtools/browser/abc" });
    assert.equal(parseVersionResponse(raw), "ws://127.0.0.1:9222/devtools/browser/abc");
  });

  test("a response without the url yields null", () => {
    assert.equal(parseVersionResponse(JSON.stringify({ Browser: "Chrome/154.0" })), null);
  });

  test("a non-string url, a non-object body, and invalid JSON all yield null", () => {
    assert.equal(parseVersionResponse(JSON.stringify({ webSocketDebuggerUrl: 42 })), null);
    assert.equal(parseVersionResponse(JSON.stringify([1, 2])), null);
    assert.equal(parseVersionResponse("not json"), null);
  });
});

describe("firstReadyPort", () => {
  const live = (port: number): PortProbe => (p) =>
    Promise.resolve(p === port ? ok(undefined) : err(cdpError("discovery_failed", "ECONNREFUSED")));

  test("a stale candidate ahead of a live one does not delay the live one by its own deadline", async () => {
    const begun = Date.now();
    const r = await firstReadyPort([{ port: 1111 }, { port: 2222 }], { probe: live(2222), deadlineMs: 5_000, intervalMs: 50 });
    assert.equal(r.success, true);
    assert.equal(r.data.port, 2222);
    assert.ok(Date.now() - begun < 1_000);
  });

  test("a candidate that becomes live after a few polls wins", async () => {
    let polls = 0;
    const probe: PortProbe = () => {
      polls++;
      return Promise.resolve(polls >= 3 ? ok(undefined) : err(cdpError("discovery_failed", "not yet")));
    };
    const r = await firstReadyPort([{ port: 1 }], { probe, deadlineMs: 5_000, intervalMs: 10 });
    assert.equal(r.success, true);
    assert.equal(polls, 3);
  });

  test("all stale candidates fail together within one shared deadline", async () => {
    const begun = Date.now();
    const r = await firstReadyPort([{ port: 1 }, { port: 2 }, { port: 3 }], { probe: live(0), deadlineMs: 200, intervalMs: 20 });
    const elapsed = Date.now() - begun;
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "discovery_failed");
    assert.match(r.error.message, /127\.0\.0\.1:1, 127\.0\.0\.1:2, 127\.0\.0\.1:3/);
    assert.match(r.error.message, /ECONNREFUSED/);
    assert.ok(elapsed >= 150 && elapsed < 1_000, `elapsed ${elapsed}ms`);
  });

  test("no candidates is an immediate failure", async () => {
    const r = await firstReadyPort([], { probe: live(1), deadlineMs: 1_000 });
    assert.equal(r.success, false);
  });
});

describe("probeEndpoint", () => {
  // Every seam is injected, so nothing on this machine (env, port files, sockets) is read.
  const deps = (over: ProbeDeps = {}): ProbeDeps => ({
    env: {},
    portFileCandidates: () => Promise.resolve([]),
    isPortLive: () => Promise.resolve(false),
    liveWsUrl: () => Promise.resolve(null),
    fallbackPorts: () => [9222],
    ...over,
  });

  test("a BU_CDP_WS override is returned without touching the network", async () => {
    let probed = false;
    const r = await probeEndpoint(deps({
      env: { BU_CDP_WS: "ws://example.test/devtools/browser/abc" },
      isPortLive: () => { probed = true; return Promise.resolve(true); },
    }));
    assert.deepEqual(r, { wsUrl: "ws://example.test/devtools/browser/abc" });
    assert.equal(probed, false);
  });

  test("a live port-file candidate wins and carries its user-data-dir", async () => {
    const r = await probeEndpoint(deps({
      portFileCandidates: () => Promise.resolve([
        { port: 5001, path: "/devtools/browser/stale", mtimeMs: 2, userDataDir: "/udd/stale" },
        { port: 5002, path: "/devtools/browser/live", mtimeMs: 1, userDataDir: "/udd/live" },
      ]),
      isPortLive: (port) => Promise.resolve(port === 5002),
    }));
    assert.deepEqual(r, { wsUrl: "ws://127.0.0.1:5002/devtools/browser/live", userDataDir: "/udd/live" });
  });

  test("the browser's own /json/version url is preferred over the port file's path", async () => {
    const r = await probeEndpoint(deps({
      portFileCandidates: () => Promise.resolve([{ port: 5002, path: "/devtools/browser/old", mtimeMs: 1, userDataDir: "/udd" }]),
      isPortLive: () => Promise.resolve(true),
      liveWsUrl: () => Promise.resolve("ws://127.0.0.1:5002/devtools/browser/current"),
    }));
    assert.deepEqual(r, { wsUrl: "ws://127.0.0.1:5002/devtools/browser/current", userDataDir: "/udd" });
  });

  test("with no live port file, an answering fallback port is an endpoint with no user-data-dir", async () => {
    const r = await probeEndpoint(deps({
      portFileCandidates: () => Promise.resolve([{ port: 5001, path: "/devtools/browser/stale", mtimeMs: 1, userDataDir: "/udd" }]),
      isPortLive: (port) => Promise.resolve(port === 9222),
      liveWsUrl: (port) => Promise.resolve(port === 9222 ? "ws://127.0.0.1:9222/devtools/browser/remote" : null),
    }));
    assert.deepEqual(r, { wsUrl: "ws://127.0.0.1:9222/devtools/browser/remote" });
  });

  test("a fallback port that is open but does not speak DevTools is not an endpoint", async () => {
    const r = await probeEndpoint(deps({ isPortLive: () => Promise.resolve(true) }));
    assert.equal(r, undefined);
  });

  test("nothing live yields undefined", async () => {
    assert.equal(await probeEndpoint(deps()), undefined);
  });
});
