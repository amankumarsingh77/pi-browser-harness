/**
 * Manual integration test for CdpBridge against real Chrome.
 * Requires: Chrome with remote debugging enabled (chrome://inspect/#remote-debugging).
 * Run: npx tsx test/manual/bridge-test.ts
 */
import { createCdpBridge, type SendToClient, type CdpBridge } from "../../src/daemon/bridge";
import type { WireRequest, WireResponse, WireEvent } from "../../src/daemon/protocol";

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string) => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
};

async function main() {
  console.log("Starting CdpBridge...");
  const bridge = createCdpBridge();

  // ── Test 1: Connect to Chrome ──────────────────────────────────────────
  // start() now runs auto-retry in the background. Wait a moment for
  // the initial connection attempt to complete.
  await bridge.start();
  await sleep(3000); // allow time for WebSocket handshake
  if (!bridge.isAlive()) {
    console.error("Cannot continue — Chrome not reachable. Run /browser-setup first.");
    console.error("(The bridge will keep retrying in the background.)");
    process.exit(1);
  }
  console.log("  ✓ Connect to Chrome: ok");
  check(bridge.isAlive(), "Bridge reports alive after connect");

  // ── Test 2: Send Target.getTargets ─────────────────────────────────────
  const responses: WireResponse[] = [];
  const events: WireEvent[] = [];
  let eventCount = 0;

  const send: SendToClient = (clientId, msg) => {
    if (msg.type === "response") responses.push(msg);
    else events.push(msg);
  };

  bridge.onEvent((evt, _targets) => { eventCount++; });

  const req1: WireRequest = { type: "request", id: 1, method: "Target.getTargets" };
  bridge.handleRequest(req1, "pi-test", send);

  await sleep(2000);

  const res1 = responses.find(r => r.id === 1);
  check(res1 != null, "Target.getTargets response received");
  if (res1?.result) {
    const r = res1.result as any;
    check(Array.isArray(r.targetInfos), "targetInfos is array");
    console.log(`    Found ${r.targetInfos?.length ?? 0} targets`);
  }

  // ── Test 3: Create a new tab ───────────────────────────────────────────
  responses.length = 0;
  const req2: WireRequest = {
    type: "request", id: 2, method: "Target.createTarget",
    params: { url: "about:blank", newWindow: true },
  };
  bridge.handleRequest(req2, "pi-test", send);
  await sleep(2000);

  const res2 = responses.find(r => r.id === 2);
  check(res2 != null, "Target.createTarget response received");
  const targetId = (res2?.result as any)?.targetId as string | undefined;
  check(typeof targetId === "string", `Created target: ${targetId ?? "FAILED"}`);

  if (!targetId) {
    console.error("Cannot continue without a target");
    await bridge.stop();
    process.exit(1);
  }

  // ── Test 4: Attach to target ───────────────────────────────────────────
  responses.length = 0;
  const req3: WireRequest = {
    type: "request", id: 3, method: "Target.attachToTarget",
    params: { targetId, flatten: true },
  };
  bridge.handleRequest(req3, "pi-test", send);
  await sleep(2000);

  const res3 = responses.find(r => r.id === 3);
  check(res3 != null, "Target.attachToTarget response received");
  const sessionId = (res3?.result as any)?.sessionId as string | undefined;
  check(typeof sessionId === "string", `Session ID: ${sessionId ?? "FAILED"}`);

  // Verify session ownership was tracked
  if (sessionId) {
    const owner = bridge.getSessionOwner(sessionId);
    check(owner === "pi-test", "Session ownership tracked correctly");
  }

  if (!sessionId) {
    await bridge.stop();
    process.exit(1);
  }

  // ── Test 5: Navigate tab via session ───────────────────────────────────
  responses.length = 0;
  const req4: WireRequest = {
    type: "request", id: 4, method: "Page.navigate",
    params: { url: "https://example.com" },
    sessionId,
  };
  bridge.handleRequest(req4, "pi-test", send);
  await sleep(3000);

  const res4 = responses.find(r => r.id === 4);
  check(res4 != null, "Page.navigate response received");
  const frameId = (res4?.result as any)?.frameId as string | undefined;
  check(typeof frameId === "string", `Navigated to example.com (frame: ${frameId ?? "FAILED"})`);

  // ── Test 6: Evaluate JS in the page ────────────────────────────────────
  responses.length = 0;
  const req5: WireRequest = {
    type: "request", id: 5, method: "Runtime.evaluate",
    params: { expression: "document.title", returnByValue: true },
    sessionId,
  };
  bridge.handleRequest(req5, "pi-test", send);
  await sleep(2000);

  const res5 = responses.find(r => r.id === 5);
  check(res5 != null, "Runtime.evaluate response received");
  const title = (res5?.result as any)?.result?.value as string | undefined;
  check(title === "Example Domain", `Page title: "${title ?? "FAILED"}" (expected "Example Domain")`);

  // ── Test 7: Detach from target ─────────────────────────────────────────
  responses.length = 0;
  const req6: WireRequest = {
    type: "request", id: 6, method: "Target.detachFromTarget",
    params: { sessionId },
  };
  bridge.handleRequest(req6, "pi-test", send);
  await sleep(1000);

  const res6 = responses.find(r => r.id === 6);
  check(res6 != null, "Target.detachFromTarget response received");

  // Session ownership should be released
  const ownerAfter = bridge.getSessionOwner(sessionId);
  check(ownerAfter === undefined, "Session ownership released after detach");

  // ── Test 8: Close target ───────────────────────────────────────────────
  responses.length = 0;
  const req7: WireRequest = {
    type: "request", id: 7, method: "Target.closeTarget",
    params: { targetId },
  };
  bridge.handleRequest(req7, "pi-test", send);
  await sleep(1000);

  const res7 = responses.find(r => r.id === 7);
  check(res7 != null, "Target.closeTarget response received");

  // ── Test 9: Remove client ──────────────────────────────────────────────
  bridge.removeClient("pi-test");
  // After removal, no pending requests should remain — verify by checking
  // no errors are thrown when handling subsequent events.

  // ── Cleanup ────────────────────────────────────────────────────────────
  console.log("\nStopping bridge...");
  await bridge.stop();
  console.log("Bridge stopped ✓");

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed > 0 ? 1 : 0);
}

function sleep(ms: number): Promise<void> {
  return new Promise(r => setTimeout(r, ms));
}

main().catch((e) => {
  console.error("Test failed:", e);
  process.exit(1);
});
