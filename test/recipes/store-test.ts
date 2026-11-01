import { test, describe, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Recipe } from "../../src/recipes/recipe";
import { saveRecipe } from "../../src/recipes/store";

describe("saveRecipe", () => {
  let base: string;

  beforeEach(() => {
    base = mkdtempSync(join(tmpdir(), "pi-recipe-store-"));
  });

  afterEach(() => {
    rmSync(base, { recursive: true, force: true });
  });

  test("SC54: a recipe whose site is \"../../escaped\" is refused and nothing is written inside or outside the root", async () => {
    const root = join(base, "a", "b", "browser-recipes");
    const recipe: Recipe = {
      name: "vendor-invoices",
      site: "../../escaped",
      version: 1,
      params: {},
      steps: [{ action: "reload", args: {} }],
      recorded: { at: "2026-10-01T00:00:00.000Z", session: "s-1" },
    };

    const saved = await saveRecipe(root, recipe);

    assert.ok(!saved.success, "expected the save to be refused");
    assert.match(saved.error, /site/);
    assert.equal(existsSync(join(base, "a", "escaped")), false);
    assert.equal(existsSync(root), false);
    assert.deepEqual(readdirSync(base), []);
  });
});
