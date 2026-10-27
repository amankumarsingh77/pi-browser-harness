import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { type Recipe, parseRecipe, stringifyRecipe } from "../../src/recipes/recipe";

const HEADER = `name: vendor-invoices
site: billing.test
version: 1
params:
  month: { type: string, example: "2026-09" }
recorded: { at: "2026-10-01T00:00:00.000Z", session: s-1 }
`;

describe("recipe file format", () => {
  test("SC20: a recipe with a param, a role+name step with expect, a css step and a scroll step parses back from its YAML unchanged", () => {
    const recipe: Recipe = {
      name: "vendor-invoices",
      site: "billing.test",
      version: 3,
      params: { month: { type: "string", example: "2026-09" } },
      steps: [
        {
          action: "select_option",
          args: { label: "{{month}}" },
          locator: { role: "combobox", name: "Period", nth: 0 },
          expect: { url: "https://billing.test/invoices?m=2026-09", appeared: [{ role: "link", name: "Loaded" }] },
        },
        { action: "click", args: {}, locator: { css: "#export" }, expect: { download: true } },
        { action: "scroll", args: { x: 10, y: 20, deltaY: 400 } },
      ],
      recorded: { at: "2026-10-01T00:00:00.000Z", session: "s-1" },
      lastRun: { at: "2026-10-02T00:00:00.000Z", result: "failed", step: 2, repairedStep: 2 },
    };

    const parsed = parseRecipe(stringifyRecipe(recipe));

    assert.ok(parsed.success, parsed.success ? "" : parsed.error);
    assert.deepEqual(parsed.data, recipe);
  });

  const invalid: ReadonlyArray<{ readonly what: string; readonly steps: string; readonly step: number }> = [
    {
      what: "step 2 uses execute_js",
      steps: `steps:\n  - navigate: { url: "https://billing.test/" }\n  - execute_js: { code: "1" }\n`,
      step: 2,
    },
    {
      what: "step 3 has two action keys",
      steps: `steps:\n  - navigate: { url: "https://billing.test/" }\n  - reload: {}\n  - click: { css: "#a" }\n    fill: { css: "#b", value: "x" }\n`,
      step: 3,
    },
    {
      what: "step 4 uses an undeclared {{year}}",
      steps: `steps:\n  - navigate: { url: "https://billing.test/" }\n  - reload: {}\n  - go_back: {}\n  - fill: { css: "#y", value: "{{year}}" }\n`,
      step: 4,
    },
  ];
  for (const c of invalid) {
    test(`SC21: a file where ${c.what} is rejected with a message naming step ${c.step}`, () => {
      const parsed = parseRecipe(HEADER + c.steps);

      assert.ok(!parsed.success);
      assert.match(parsed.error, new RegExp(`^step ${c.step}:`));
    });
  }

  test("SC53: a file whose site is \"../x\" is rejected before any step is read", () => {
    const parsed = parseRecipe(HEADER.replace("site: billing.test", 'site: "../x"') + `steps:\n  - reload: {}\n`);

    assert.ok(!parsed.success, "expected site ../x to be rejected");
    assert.match(parsed.error, /site|pattern/);
  });
});
