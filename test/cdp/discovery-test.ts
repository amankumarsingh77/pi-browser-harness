import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { endpointFromEnv, firstReadyPort, parseVersionResponse, rewriteWsHost, type PortProbe } from "../../src/cdp/discovery";
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

  test("a candidate's host is passed through to the probe and the winner carries it", async () => {
    const probedHosts: Array<string | undefined> = [];
    const liveAt = (host: string): PortProbe => (_port, h) => {
      probedHosts.push(h);
      return Promise.resolve(h === host ? ok(undefined) : err(cdpError("discovery_failed", "refused")));
    };
    const r = await firstReadyPort(
      [{ port: 9222, host: "127.0.0.1" }, { port: 9222, host: "172.21.48.1" }],
      { probe: liveAt("172.21.48.1"), deadlineMs: 1_000, intervalMs: 20 },
    );
    assert.equal(r.success, true);
    assert.equal(r.data.host, "172.21.48.1");
    assert.ok(probedHosts.includes("127.0.0.1"));
    assert.ok(probedHosts.includes("172.21.48.1"));
  });

  test("same port on different hosts are distinct race participants", async () => {
    const r = await firstReadyPort(
      [{ port: 7 }, { port: 7, host: "gateway" }],
      { probe: (_p, h) => Promise.resolve(h === "gateway"
        ? err(cdpError("discovery_failed", "refused on gateway"))
        : ok(undefined)), deadlineMs: 500, intervalMs: 20 },
    );
    assert.equal(r.success, true);
    assert.equal(r.data.host, undefined);
  });

  test("failure labels distinguish hosts for the same port", async () => {
    const r = await firstReadyPort(
      [{ port: 7, host: "127.0.0.1" }, { port: 7, host: "gateway" }],
      { probe: () => Promise.resolve(err(cdpError("discovery_failed", "refused"))), deadlineMs: 100, intervalMs: 20 },
    );
    assert.equal(r.success, false);
    assert.match(r.error.message, /127\.0\.0\.1:7, gateway:7/);
  });
});

describe("rewriteWsHost", () => {
  test("a loopback url is re-dialed at the bridge host", () => {
    assert.equal(
      rewriteWsHost("ws://127.0.0.1:9222/devtools/browser/abc", "172.21.48.1"),
      "ws://172.21.48.1:9222/devtools/browser/abc",
    );
  });

  test("localhost is rewritten too", () => {
    assert.equal(rewriteWsHost("ws://localhost:9222/x", "172.21.48.1"), "ws://172.21.48.1:9222/x");
  });

  test("a loopback host leaves the url untouched", () => {
    const url = "ws://127.0.0.1:9222/devtools/browser/abc";
    assert.equal(rewriteWsHost(url, "127.0.0.1"), url);
    assert.equal(rewriteWsHost(url, "localhost"), url);
  });

  test("an already-remote hostname is left alone", () => {
    assert.equal(rewriteWsHost("ws://devbox:9222/x", "172.21.48.1"), "ws://devbox:9222/x");
  });

  test("an unparseable url is returned unchanged", () => {
    assert.equal(rewriteWsHost("not a url", "172.21.48.1"), "not a url");
  });
});
