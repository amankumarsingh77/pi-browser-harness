import { createBrowserClient } from "../../src/client";
import { createVirtualCursorController } from "../../src/cursor/controller";
import type { CursorPoint, VirtualCursorController } from "../../src/cursor/types";
import { createDaemonTransport } from "../../src/daemon/transport";
import { ok } from "../../src/util/result";

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

type Sample = { readonly from: CursorPoint; readonly to: CursorPoint };
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

const runMove = async (
  cursor: VirtualCursorController,
  target: { readonly targetId: string; readonly sessionId: string },
  sample: Sample,
): Promise<number> => {
  const result = await cursor.runPointerAction(target, undefined, async (visual) => {
    await visual.moveTo(sample.from, true);
    const started = process.hrtime.bigint();
    await visual.moveTo(sample.to);
    return ok(Number(process.hrtime.bigint() - started) / 1_000_000);
  });
  if (!result.success) throw new Error(result.error.message);
  return result.data;
};

const warm = async (
  cursor: VirtualCursorController,
  target: { readonly targetId: string; readonly sessionId: string },
  samples: ReadonlyArray<Sample>,
): Promise<void> => {
  for (const sample of samples.slice(0, WARM_UPS)) await runMove(cursor, target, sample);
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
      `<!doctype html><style>html,body{margin:0;width:${WIDTH}px;height:${HEIGHT}px}</style><body>virtual cursor benchmark</body>`,
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
    const enabled = createVirtualCursorController(client, {});
    const disabled = createVirtualCursorController(client, { enabled: false });

    // The first enabled move installs the overlay and is intentionally outside warm-ups and samples.
    await runMove(enabled, target, { from: { x: 80, y: HEIGHT / 2 }, to: { x: 180, y: HEIGHT / 2 } });

    let worstDelta = Number.NEGATIVE_INFINITY;
    for (let round = 1; round <= ROUNDS; round++) {
      const samples = samplesForRound(round);
      await warm(enabled, target, samples);
      await warm(disabled, target, samples);

      const enabledSamples: number[] = [];
      const disabledSamples: number[] = [];
      for (const sample of samples) enabledSamples.push(await runMove(enabled, target, sample));
      for (const sample of samples) disabledSamples.push(await runMove(disabled, target, sample));

      const enabledP95 = p95(enabledSamples);
      const disabledP95 = p95(disabledSamples);
      const delta = enabledP95 - disabledP95;
      worstDelta = Math.max(worstDelta, delta);
      console.log(
        `round ${round}: enabled P95 ${enabledP95.toFixed(2)}ms, disabled P95 ${disabledP95.toFixed(2)}ms, delta ${delta.toFixed(2)}ms`,
      );
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
