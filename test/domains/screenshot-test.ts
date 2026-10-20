import { test, describe, after } from "node:test";
import assert from "node:assert/strict";
import { readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { visibleWidth } from "@mariozechner/pi-tui";
import { type Canned, createFakeClient, type FakeClient, handlerContext } from "./fake-client";
import { pngOf, renderWith, renderedText } from "./client-overrides";
import { type ScreenshotDetails, screenshotTool } from "../../src/domains/screenshot";
import { captureBase, captureWithCrosshair, resizeIfNeeded } from "../../src/domains/screenshot-capture";
import { loadSharp } from "../../src/util/sharp-shim";
import { cdpError } from "../../src/cdp/errors";
import { err, ok } from "../../src/util/result";

const PNG_1x1 = pngOf(1, 1);
const SHOT = ok({ data: PNG_1x1.toString("base64") });

// Every capture lands in the OS temp dir under a fresh uuid; the files are removed once the suite ends.
const produced: string[] = [];
after(async () => {
  await Promise.all(produced.map((p) => rm(p, { force: true })));
});

const capturing = (canned: Canned = {}): Promise<FakeClient> =>
  createFakeClient({ canned: { "Page.captureScreenshot": SHOT, ...canned } });

const details = (d: ScreenshotDetails | undefined): ScreenshotDetails => {
  assert.ok(d, "a successful screenshot carries details");
  return d;
};

const render = renderWith(screenshotTool);

describe("browser_screenshot", () => {
  test("defaults to a png of the viewport, writes the decoded bytes and reports the path", async () => {
    const fake = await capturing();
    const r = await screenshotTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    const d = details(r.data.details);
    produced.push(d.path);
    assert.deepEqual(fake.calls.map((c) => [c.method, c.params, c.sessionId]), [
      ["Page.captureScreenshot", { format: "png", captureBeyondViewport: false }, "s1"],
    ]);
    assert.match(d.path, /pi-browser-screenshot-fake-[0-9a-f-]+\.png$/);
    assert.equal(d.path.startsWith(tmpdir()), true);
    assert.deepEqual(d, { path: d.path, format: "png", attached: false });
    assert.equal(r.data.text, `Screenshot saved: ${d.path}`);
    assert.deepEqual(await readFile(d.path), PNG_1x1);
  });

  test("jpeg carries its quality and a .jpeg extension; png never sends quality", async () => {
    const fake = await capturing();
    const r = await screenshotTool.handler({ format: "jpeg", quality: 55 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    const d = details(r.data.details);
    produced.push(d.path);
    assert.deepEqual(fake.calls[0]?.params, { format: "jpeg", captureBeyondViewport: false, quality: 55 });
    assert.match(d.path, /\.jpeg$/);
    assert.equal(d.format, "jpeg");

    const png = await capturing();
    const p = await screenshotTool.handler({ format: "png", quality: 55 }, handlerContext(png.client));
    assert.equal(p.success, true);
    produced.push(details(p.data.details).path);
    assert.equal("quality" in (png.calls[0]?.params ?? {}), false);
  });

  test("jpeg without an explicit quality uses 80", async () => {
    const fake = await capturing();
    const r = await screenshotTool.handler({ format: "jpeg" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    produced.push(details(r.data.details).path);
    assert.equal(fake.calls[0]?.params["quality"], 80);
  });

  test("fullPage maps to captureBeyondViewport", async () => {
    const fake = await capturing();
    const r = await screenshotTool.handler({ fullPage: true }, handlerContext(fake.client));
    assert.equal(r.success, true);
    produced.push(details(r.data.details).path);
    assert.equal(fake.calls[0]?.params["captureBeyondViewport"], true);
  });

  test("a capture failure is a cdp_error naming the method and writes nothing", async () => {
    const fake = await capturing({ "Page.captureScreenshot": err(cdpError("remote_error", "Unable to capture screenshot")) });
    const r = await screenshotTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "Unable to capture screenshot");
    assert.deepEqual(r.error.details, { method: "Page.captureScreenshot" });
  });

  test("a capture timeout keeps the timeout kind", async () => {
    const fake = await capturing({ "Page.captureScreenshot": err(cdpError("timeout", "no frame")) });
    const r = await screenshotTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
  });

  test("a capture result without image data is an invalid-response cdp_error", async () => {
    const fake = await capturing({ "Page.captureScreenshot": ok({}) });
    const r = await screenshotTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.deepEqual(r.error.details, { method: "Page.captureScreenshot" });
  });

  test("maxDim on an image already within bounds leaves the file and the text alone", async () => {
    const fake = await capturing();
    const r = await screenshotTool.handler({ maxDim: 100 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    const d = details(r.data.details);
    produced.push(d.path);
    const load = await loadSharp();
    if (load.kind === "ok") {
      assert.equal(r.data.text, `Screenshot saved: ${d.path}`);
      assert.deepEqual(await readFile(d.path), PNG_1x1);
    } else {
      assert.match(r.data.text, /\(maxDim ignored: /);
    }
  });
});

describe("resizeIfNeeded", () => {
  test("shrinks an image whose larger side exceeds maxDim and says so", async () => {
    const load = await loadSharp();
    const path = join(tmpdir(), `bh-resize-${process.pid}-${Date.now()}.png`);
    produced.push(path);
    await writeFile(path, pngOf(8, 4));
    const r = await resizeIfNeeded(path, 4);
    if (load.kind !== "ok") {
      assert.match(r.note, /^ \(maxDim ignored: /);
      return;
    }
    assert.equal(r.note, " (resized to fit 4px)");
    const meta = await load.sharp(path).metadata();
    assert.equal(meta.width, 4);
    assert.equal(meta.height, 2);
  });

  test("an unreadable file is reported in the note, never thrown", async () => {
    const path = join(tmpdir(), `bh-resize-missing-${process.pid}.png`);
    const r = await resizeIfNeeded(path, 100);
    assert.match(r.note, /^ \(maxDim ignored: /);
  });
});

describe("captureBase and captureWithCrosshair", () => {
  test("captureBase returns the path and format it wrote", async () => {
    const fake = await capturing();
    const r = await captureBase(fake.client, { format: "jpeg", quality: 10 });
    assert.equal(r.success, true);
    produced.push(r.data.path);
    assert.equal(r.data.format, "jpeg");
    assert.match(r.data.path, /\.jpeg$/);
  });

  test("captureWithCrosshair returns a file at the capture path even when the overlay cannot be drawn", async () => {
    const fake = await capturing();
    const r = await captureWithCrosshair(fake.client, { x: 0, y: 0 });
    assert.equal(r.success, true);
    produced.push(r.data.path);
    const bytes = await readFile(r.data.path);
    assert.ok(bytes.length > 0);
  });

  test("captureWithCrosshair propagates a capture failure", async () => {
    const fake = await capturing({ "Page.captureScreenshot": err(cdpError("remote_error", "nope")) });
    const r = await captureWithCrosshair(fake.client, { x: 1, y: 1 });
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
  });
});

describe("browser_screenshot renderResult", () => {
  const result = (path: string, format: "png" | "jpeg") => ({
    content: [{ type: "text" as const, text: `Screenshot saved: ${path}` }],
    details: { path, format, attached: false as const },
  });

  test("a missing file falls back to the saved-path text", () => {
    const path = join(tmpdir(), `bh-missing-${process.pid}.png`);
    const text = renderedText(render(result(path, "png"), false));
    assert.equal(text, `Screenshot saved: ${path}`);
  });

  test("an existing file renders lines that never exceed the requested width", async () => {
    const path = join(tmpdir(), `bh-render-${process.pid}-${Date.now()}-${"x".repeat(60)}.png`);
    produced.push(path);
    await writeFile(path, PNG_1x1);
    const component = render(result(path, "png"), true);
    const lines = component.render(24);
    assert.ok(lines.length > 0);
    for (const line of lines) assert.ok(visibleWidth(line) <= 24, `line wider than 24 cells: ${line}`);
    component.invalidate();
  });
});
