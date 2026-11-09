import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { locateBrowser, type LocateDeps } from "../../src/browser-location";
import type { CdpEndpoint } from "../../src/cdp/discovery";

const PORT_ONLY: CdpEndpoint = { wsUrl: "ws://127.0.0.1:9222/devtools/browser/x" };
const FROM_PORT_FILE: CdpEndpoint = { wsUrl: "ws://127.0.0.1:5002/devtools/browser/y", userDataDir: "/home/u/.config/google-chrome" };
const OVERRIDE = "ws://example.test/devtools/browser/abc";

// Every seam is injected, so the result never depends on what is running on this machine.
const deps = (opts: { readonly override?: string; readonly endpoint?: CdpEndpoint; readonly running: boolean }): LocateDeps => ({
  env: opts.override === undefined ? {} : { BU_CDP_WS: opts.override },
  probeEndpoint: () => Promise.resolve(opts.endpoint),
  isBrowserRunning: () => Promise.resolve(opts.running),
});

describe("locateBrowser", () => {
  test("BU_CDP_WS with no local browser process is a remote browser", async () => {
    const r = await locateBrowser(deps({ override: OVERRIDE, running: false }));
    assert.deepEqual(r, { kind: "remote", endpoint: { wsUrl: OVERRIDE } });
  });

  test("BU_CDP_WS alongside a local browser process stays local, so profile features keep working", async () => {
    const r = await locateBrowser(deps({ override: OVERRIDE, running: true }));
    assert.deepEqual(r, { kind: "local", endpoint: { wsUrl: OVERRIDE } });
  });

  test("an endpoint found through a port file on this machine is local even when no process was detected", async () => {
    const r = await locateBrowser(deps({ endpoint: FROM_PORT_FILE, running: false }));
    assert.deepEqual(r, { kind: "local", endpoint: FROM_PORT_FILE });
  });

  test("a port that answers alongside a local browser process is local", async () => {
    const r = await locateBrowser(deps({ endpoint: PORT_ONLY, running: true }));
    assert.deepEqual(r, { kind: "local", endpoint: PORT_ONLY });
  });

  test("a port that answers with no local browser process is remote (tunnel, WSL host, container)", async () => {
    const r = await locateBrowser(deps({ endpoint: PORT_ONLY, running: false }));
    assert.deepEqual(r, { kind: "remote", endpoint: PORT_ONLY });
  });

  test("a local browser process with no endpoint is local with remote debugging off", async () => {
    const r = await locateBrowser(deps({ running: true }));
    assert.deepEqual(r, { kind: "local" });
  });

  test("no endpoint and no local process is no browser at all", async () => {
    const r = await locateBrowser(deps({ running: false }));
    assert.deepEqual(r, { kind: "none" });
  });
});
