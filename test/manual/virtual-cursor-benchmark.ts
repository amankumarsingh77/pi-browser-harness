import { createBrowserClient } from "../../src/client";
import { createVirtualCursorController } from "../../src/cursor/controller";
import { createDaemonTransport } from "../../src/daemon/transport";
import { clickTool } from "../../src/domains/click";

const distanceBuckets = [
  { share: 0.25, min: 100, max: 150 },
  { share: 0.50, min: 400, max: 600 },
  { share: 0.25, min: 900, max: 1100 },
] as const;

const WIDTH = 1280;
const HEIGHT = 800;
const WARM_UPS = 20;
const SAMPLES = 200;
const ROUNDS = 3;
const MAX_INCREMENTAL_P95_MS = 220;

type Sample = { readonly from: { readonly x: number; readonly y: number }; readonly to: { readonly x: number; readonly y: number } };
type BucketIndex = 0 | 1 | 2;

const seededRandom = (seed: number): (() => number) => {
  let value = seed >>> 0;
  return () => {
    value = (value * 1664525 + 1013904223) >>> 0;
    return value / 0x1_0000_0000;
  };
};

const samplesForRound = (round: number): ReadonlyArray<Sample> => {
  const random = seededRandom(0x5eed_0000 + round);
  const bucketIndexes: BucketIndex[] = Array.from({ length: SAMPLES }, (_, index): BucketIndex =>
    index < SAMPLES * distanceBuckets[0].share
      ? 0
      : index < SAMPLES * (distanceBuckets[0].share + distanceBuckets[1].share)
        ? 1
        : 2,
  );
  for (let index = bucketIndexes.length - 1; index > 0; index--) {
    const swap = Math.floor(random() * (index + 1));
    const current = bucketIndexes[index]!;
    bucketIndexes[index] = bucketIndexes[swap]!;
    bucketIndexes[swap] = current;
  }
  return bucketIndexes.map((bucketIndex) => {
    const bucket = distanceBuckets[bucketIndex]!;
    const distance = bucket.min + Math.floor(random() * (bucket.max - bucket.min + 1));
    return {
      from: { x: 80, y: HEIGHT / 2 },
      to: { x: 80 + distance, y: HEIGHT / 2 },
    };
  });
};

const p95 = (samples: ReadonlyArray<number>): number => {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.ceil(sorted.length * 0.95) - 1]!;
};

const runStableClick = async (
  context: any,
  ref: string,
): Promise<number> => {
  const started = process.hrtime.bigint();
  const result = await clickTool.handler({ ref }, context);
  if (!result.success) throw new Error(result.error.message);
  return Number(process.hrtime.bigint() - started) / 1_000_000;
};

const warm = async (
  client: any,
  enabled: ReturnType<typeof createVirtualCursorController>,
  context: any,
  ref: string,
  samples: ReadonlyArray<Sample>,
): Promise<void> => {
  for (const sample of samples.slice(0, WARM_UPS)) {
    await client.evaluateJs(`document.getElementById("target").style.left = "${sample.to.x}px"; document.getElementById("target").style.top = "${sample.to.y}px"`);
    await enabled.runPointerAction(client.current()!, undefined, async (visual) => {
      await visual.moveTo(sample.from, true);
      return { success: true, data: undefined };
    });
    await runStableClick(context, ref);
  }
};

async function main(): Promise<void> {
  const transport = createDaemonTransport("pi-virtual-cursor-benchmark");
  const client = createBrowserClient({ namespace: "pi-virtual-cursor-benchmark", transport });
  let tabId: string | undefined;

  try {
    const started = await client.start();
    if (!started.success) {
      console.error(`NEEDS_CONTEXT: Chrome remote debugging is unavailable: ${started.error.message}`);
      process.exitCode = 2;
      return;
    }

    const tab = await client.newTab(`data:text/html,${encodeURIComponent(
      `<!doctype html><style>html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px}#target{position:absolute;width:1px;height:1px;padding:0;border:0}</style><button id="target">target</button><script>window.clicks=0;document.getElementById("target").addEventListener("click",()=>window.clicks++)</script>`,
    )}`);
    if (!tab.success) throw new Error(`could not open fixture: ${tab.error.message}`);
    tabId = tab.data;

    const viewport = await client.session().call("Emulation.setDeviceMetricsOverride", {
      width: WIDTH,
      height: HEIGHT,
      deviceScaleFactor: 1,
      mobile: false,
    });
    if (!viewport.success) throw new Error(viewport.error.message);

    const target = client.current();
    if (!target) throw new Error("fixture tab is not attached");
    const ax = await client.session().call("Accessibility.getFullAXTree", {});
    const targetNode = ax.success
      ? ax.data.nodes.find((node: any) => node.name?.value === "target" && typeof node.backendDOMNodeId === "number")
      : undefined;
    if (targetNode?.backendDOMNodeId === undefined) throw new Error("benchmark fixture target is missing from the accessibility tree");
    client.session().setRefMap(new Map([["e1", targetNode.backendDOMNodeId]]), new Map([["e1", "|target||"]]));
    const ref = "e1";
    const enabled = createVirtualCursorController(client, {});
    const disabled = createVirtualCursorController(client, { enabled: false });
    const contextFor = (cursor: unknown) => ({
      client,
      cursor,
      signal: undefined,
      onUpdate: () => {},
      extensionCtx: { cwd: process.cwd() },
    });
    const enabledContext = contextFor(enabled);
    const disabledContext = contextFor(disabled);

    // The first enabled click installs the overlay and is intentionally outside warm-ups and samples.
    await client.evaluateJs('document.getElementById("target").style.left = "180px"; document.getElementById("target").style.top = "400px"');
    await runStableClick(enabledContext, ref);

    let worstDelta = Number.NEGATIVE_INFINITY;
    for (let round = 1; round <= ROUNDS; round++) {
      const samples = samplesForRound(round);
      await warm(client, enabled, enabledContext, ref, samples);
      await warm(client, enabled, disabledContext, ref, samples);

      const enabledSamples: number[] = [];
      const disabledSamples: number[] = [];
      for (const sample of samples) {
        await client.evaluateJs(`document.getElementById("target").style.left = "${sample.to.x}px"; document.getElementById("target").style.top = "${sample.to.y}px"`);
        await enabled.runPointerAction(target, undefined, async (visual) => {
          await visual.moveTo(sample.from, true);
          return { success: true, data: undefined };
        });
        enabledSamples.push(await runStableClick(enabledContext, ref));
      }
      for (const sample of samples) {
        await client.evaluateJs(`document.getElementById("target").style.left = "${sample.to.x}px"; document.getElementById("target").style.top = "${sample.to.y}px"`);
        disabledSamples.push(await runStableClick(disabledContext, ref));
      }

      const enabledP95 = p95(enabledSamples);
      const disabledP95 = p95(disabledSamples);
      const delta = enabledP95 - disabledP95;
      worstDelta = Math.max(worstDelta, delta);
      console.log(
        `round ${round}: enabled P95 ${enabledP95.toFixed(2)}ms, disabled P95 ${disabledP95.toFixed(2)}ms, delta ${delta.toFixed(2)}ms`,
      );
    }

    const expectedClicks = 1 + ROUNDS * 2 * (WARM_UPS + SAMPLES);
    const clicks = await client.evaluateJs("window.clicks");
    if (!clicks.success || clicks.data !== expectedClicks) {
      throw new Error(`benchmark fixture received ${String(clicks.success ? clicks.data : undefined)} clicks; expected ${expectedClicks}`);
    }
    console.log(`worst incremental P95 delta: ${worstDelta.toFixed(2)}ms (limit ${MAX_INCREMENTAL_P95_MS}ms)`);
    if (worstDelta > MAX_INCREMENTAL_P95_MS) {
      console.error(`FAIL: virtual cursor incremental P95 delta exceeds ${MAX_INCREMENTAL_P95_MS}ms`);
      process.exitCode = 1;
    }
  } finally {
    if (tabId !== undefined) await client.closeTab(tabId);
    await client.stop();
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
