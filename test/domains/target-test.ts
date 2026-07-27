import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveTarget } from "../../src/domains/target";
import type { BrowserClient } from "../../src/client";

const noClient = {} as unknown as BrowserClient;

const clientWithRef = (refs: Record<string, number>, boxes: Record<number, unknown>): BrowserClient => {
  const session = {
    resolveRef: (ref: string): number | undefined => refs[ref],
    call: (_method: string, params: { readonly backendNodeId?: number }) => {
      const model = params.backendNodeId === undefined ? undefined : boxes[params.backendNodeId];
      return Promise.resolve(
        model === undefined
          ? { success: false as const, error: { kind: "protocol", message: "No node found" } }
          : { success: true as const, data: { model } },
      );
    },
  };
  return { session: () => session } as unknown as BrowserClient;
};

describe("resolveTarget", () => {
  test("uses literal x/y when no ref is given", async () => {
    const r = await resolveTarget(noClient, { x: 10, y: 20 });
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.x, 10);
      assert.equal(r.data.y, 20);
      assert.equal(r.data.label, "(10, 20)");
    }
  });

  test("errors when neither ref nor a complete coordinate pair is given", async () => {
    const r = await resolveTarget(noClient, {});
    assert.equal(r.success, false);
    if (!r.success) assert.equal(r.error.kind, "invalid_state");
  });

  test("a half-specified coordinate pair is an error, not a silent zero", async () => {
    const r = await resolveTarget(noClient, { x: 10 });
    assert.equal(r.success, false);
  });

  test("a half-specified y-only pair is an error too", async () => {
    const r = await resolveTarget(noClient, { y: 20 });
    assert.equal(r.success, false);
  });

  test("a ref resolves to the box centre and takes precedence over x/y", async () => {
    const client = clientWithRef({ e7: 42 }, { 42: { content: [100, 200, 140, 200, 140, 260, 100, 260], width: 40, height: 60 } });
    const r = await resolveTarget(client, { ref: "e7", x: 1, y: 2 });
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.x, 120);
      assert.equal(r.data.y, 230);
      assert.equal(r.data.label, "[e7] (120, 230)");
    }
  });

  test("an unknown ref fails as a stale ref rather than falling back to x/y", async () => {
    const client = clientWithRef({}, {});
    const r = await resolveTarget(client, { ref: "e9", x: 1, y: 2 });
    assert.equal(r.success, false);
    if (!r.success) {
      assert.equal(r.error.kind, "invalid_state");
      assert.match(r.error.message, /stale/);
    }
  });
});
