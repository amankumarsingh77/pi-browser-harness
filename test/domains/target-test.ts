import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { resolveTarget } from "../../src/domains/target";
import { ok } from "../../src/util/result";
import { createFakeClient, type FakeClient } from "./fake-client";

const boxModel = (content: ReadonlyArray<number>, width: number, height: number): Readonly<Record<string, unknown>> => ({
  model: { content, padding: content, border: content, margin: content, width, height },
});

const clientWithRef = (ref: string, backendId: number, box?: Readonly<Record<string, unknown>>): Promise<FakeClient> =>
  createFakeClient({
    refs: [{ ref, backendId }],
    ...(box !== undefined ? { canned: { "DOM.getBoxModel": ok(box) } } : {}),
  });

describe("resolveTarget", () => {
  test("uses literal x/y when no ref is given", async () => {
    const fake = await createFakeClient();
    const r = await resolveTarget(fake.client, { x: 10, y: 20 });
    assert.equal(r.success, true);
    assert.equal(r.data.x, 10);
    assert.equal(r.data.y, 20);
    assert.equal(r.data.label, "(10, 20)");
  });

  test("errors when neither ref nor a complete coordinate pair is given", async () => {
    const fake = await createFakeClient();
    const r = await resolveTarget(fake.client, {});
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
  });

  test("a half-specified coordinate pair is an error, not a silent zero", async () => {
    const fake = await createFakeClient();
    const r = await resolveTarget(fake.client, { x: 10 });
    assert.equal(r.success, false);
  });

  test("a half-specified y-only pair is an error too", async () => {
    const fake = await createFakeClient();
    const r = await resolveTarget(fake.client, { y: 20 });
    assert.equal(r.success, false);
  });

  test("a ref resolves to the box centre and takes precedence over x/y", async () => {
    const fake = await clientWithRef("e7", 42, boxModel([100, 200, 140, 200, 140, 260, 100, 260], 40, 60));
    const r = await resolveTarget(fake.client, { ref: "e7", x: 1, y: 2 });
    assert.equal(r.success, true);
    assert.equal(r.data.x, 120);
    assert.equal(r.data.y, 230);
    assert.equal(r.data.label, "[e7] (120, 230)");
  });

  test("an unknown ref fails as a stale ref rather than falling back to x/y", async () => {
    const fake = await clientWithRef("e1", 1);
    const r = await resolveTarget(fake.client, { ref: "e9", x: 1, y: 2 });
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_state");
    assert.match(r.error.message, /stale/);
  });
});
