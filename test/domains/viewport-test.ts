import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient, handlerContext } from "./fake-client";
import { viewportResizeTool } from "../../src/domains/viewport";
import { cdpError } from "../../src/cdp/errors";
import { err } from "../../src/util/result";

describe("browser_viewport_resize", () => {
  test("sets a non-mobile device metrics override with scale factor 1 by default", async () => {
    const fake = await createFakeClient();
    const r = await viewportResizeTool.handler({ width: 800, height: 600 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(fake.calls.map((c) => [c.method, c.params, c.sessionId]), [
      ["Emulation.setDeviceMetricsOverride", { width: 800, height: 600, deviceScaleFactor: 1, mobile: false }, "s1"],
    ]);
    assert.equal(r.data.text, "Viewport set to 800x600 @1x");
    assert.deepEqual(r.data.details, { width: 800, height: 600, deviceScaleFactor: 1 });
  });

  test("forwards an explicit device scale factor", async () => {
    const fake = await createFakeClient();
    const r = await viewportResizeTool.handler({ width: 390, height: 844, deviceScaleFactor: 2 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(fake.calls[0]?.params["deviceScaleFactor"], 2);
    assert.equal(r.data.text, "Viewport set to 390x844 @2x");
    assert.deepEqual(r.data.details, { width: 390, height: 844, deviceScaleFactor: 2 });
  });

  test("a fractional scale factor is passed through unchanged", async () => {
    const fake = await createFakeClient();
    const r = await viewportResizeTool.handler({ width: 100, height: 100, deviceScaleFactor: 1.5 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Viewport set to 100x100 @1.5x");
  });

  test("a CDP failure is a cdp_error naming the method", async () => {
    const fake = await createFakeClient({
      canned: { "Emulation.setDeviceMetricsOverride": err(cdpError("remote_error", "Invalid parameters")) },
    });
    const r = await viewportResizeTool.handler({ width: 800, height: 600 }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "Invalid parameters");
    assert.deepEqual(r.error.details, { method: "Emulation.setDeviceMetricsOverride" });
  });

  test("a CDP timeout keeps the timeout kind", async () => {
    const fake = await createFakeClient({
      canned: { "Emulation.setDeviceMetricsOverride": err(cdpError("timeout", "no reply")) },
    });
    const r = await viewportResizeTool.handler({ width: 800, height: 600 }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
  });
});
