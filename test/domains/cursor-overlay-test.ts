import { describe, test } from "node:test";
import assert from "node:assert/strict";
import {
  CURSOR_BOOTSTRAP_SOURCE,
  cursorCommandExpression,
  ensureOverlay,
} from "../../src/cursor/page-overlay";
import { createFakeClient } from "./fake-client";
import { ok } from "../../src/util/result";

describe("page cursor overlay", () => {
  test("creates an isolated layer without page event APIs", () => {
    assert.match(CURSOR_BOOTSTRAP_SOURCE, /Symbol\.for\("pi-browser-harness\.cursor\.v1"\)/);
    assert.match(CURSOR_BOOTSTRAP_SOURCE, /attachShadow\(\{ mode: "closed" \}\)/);
    assert.match(CURSOR_BOOTSTRAP_SOURCE, /pointer-events/);
    assert.doesNotMatch(CURSOR_BOOTSTRAP_SOURCE, /innerHTML/);
    assert.doesNotMatch(CURSOR_BOOTSTRAP_SOURCE, /showPopover|showModal/);
  });

  test("ensureOverlay validates version, connection, and critical styles", async () => {
    const fake = await createFakeClient({
      evaluate: () => ok({
        version: 1,
        connected: true,
        visible: true,
        reducedMotion: false,
      }),
    });

    const result = await ensureOverlay(fake.client, "s1");

    assert.equal(result.success, true);
    assert.equal(fake.evaluated.length, 1);
  });

  test("structural bootstrap health does not require transient visibility", async () => {
    const fake = await createFakeClient({
      evaluate: () => ok({
        version: 1,
        connected: true,
        visible: false,
        reducedMotion: false,
      }),
    });

    const result = await ensureOverlay(fake.client, "s1");

    assert.equal(result.success, true);
  });

  test("the host is aria-hidden without programmatic focusability", () => {
    assert.doesNotMatch(CURSOR_BOOTSTRAP_SOURCE, /setAttribute\("tabindex"/);
    assert.match(CURSOR_BOOTSTRAP_SOURCE, /classList\.remove\("capture-hidden"\)/);
  });

  test("removes a connected host from an incompatible overlay version before replacing it", () => {
    assert.match(
      CURSOR_BOOTSTRAP_SOURCE,
      /if \(existing && existing\.host && existing\.host\.isConnected\) \{\s*existing\.host\.remove\(\);\s*\}/,
    );
    assert.match(CURSOR_BOOTSTRAP_SOURCE, /delete globalThis\[key\];/);
  });

  test("builds expressions for every page-side command", () => {
    const commands = [
      cursorCommandExpression("move", { x: 10, y: 20, duration: 60 }),
      cursorCommandExpression("press", { button: "left" }),
      cursorCommandExpression("release", { button: "left", count: 1 }),
      cursorCommandExpression("scroll", { deltaX: 0, deltaY: 300 }),
      cursorCommandExpression("hide"),
      cursorCommandExpression("show"),
      cursorCommandExpression("destroy"),
      cursorCommandExpression("snapshot"),
    ];

    for (const expression of commands) {
      assert.match(expression, /pi-browser-harness\.cursor\.v1/);
    }
  });

  test("checks Top Layer overlap at the final point for strict capture", () => {
    const expression = `${CURSOR_BOOTSTRAP_SOURCE}\n${cursorCommandExpression("show", { strict: true })}`;

    assert.match(expression, /fullscreenElement/);
    assert.match(expression, /dialog:modal/);
    assert.match(expression, /:popover-open/);
  });
});
