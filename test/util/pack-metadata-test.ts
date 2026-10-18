import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findMissingRuntimeDeps, RUNTIME_DEPS } from "../../scripts/check-pack";

describe("packed-manifest runtime-deps contract", () => {
  test("reports nothing missing when all runtime deps are declared", () => {
    const manifest = { dependencies: { tsx: "^4.22.4", ws: "^8.20.0" } };
    assert.deepEqual(findMissingRuntimeDeps(manifest), []);
  });

  test("flags the 0.11.0 defect: tsx missing from dependencies", () => {
    // Shape of the published pi-browser-harness@0.11.0 manifest, whose
    // missing tsx broke daemon startup (browser-use/browser-harness#808).
    const manifest = { dependencies: { ws: "^8.20.0" } };
    assert.deepEqual(findMissingRuntimeDeps(manifest), ["tsx"]);
  });

  test("treats a missing or malformed dependencies field as all-missing", () => {
    assert.deepEqual(findMissingRuntimeDeps({}), [...RUNTIME_DEPS]);
    assert.deepEqual(findMissingRuntimeDeps({ dependencies: null }), [...RUNTIME_DEPS]);
    assert.deepEqual(findMissingRuntimeDeps({ dependencies: [] }), [...RUNTIME_DEPS]);
  });

  test("ignores peer and devDependencies", () => {
    const manifest = {
      dependencies: { ws: "^8.20.0" },
      peerDependencies: { tsx: "*" },
      devDependencies: { tsx: "^4.22.4" },
    };
    assert.deepEqual(findMissingRuntimeDeps(manifest), ["tsx"]);
  });

  test("this package declares every runtime dep in dependencies", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    );
    assert.deepEqual(findMissingRuntimeDeps(manifest), []);
  });
});
