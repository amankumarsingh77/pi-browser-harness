import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { findHostProvidedDependencies } from "../../scripts/check-manifest";

describe("host-provided manifest contract", () => {
  test("flags host-provided packages listed in dependencies", () => {
    const manifest = { dependencies: { ws: "^8.20.0", typebox: "^1.3.34" } };
    assert.deepEqual(findHostProvidedDependencies(manifest), ["typebox"]);
  });

  test("recognises every pi-provided package", () => {
    const manifest = {
      dependencies: {
        typebox: "*",
        "@sinclair/typebox": "*",
        "@mariozechner/pi-tui": "*",
        "@earendil-works/pi-coding-agent": "*",
      },
    };
    assert.deepEqual(findHostProvidedDependencies(manifest), [
      "@earendil-works/pi-coding-agent",
      "@mariozechner/pi-tui",
      "@sinclair/typebox",
      "typebox",
    ]);
  });

  test("ignores peer and devDependencies", () => {
    const manifest = {
      peerDependencies: { typebox: "*" },
      devDependencies: { typebox: "*" },
    };
    assert.deepEqual(findHostProvidedDependencies(manifest), []);
  });

  test("tolerates a missing or malformed dependencies field", () => {
    assert.deepEqual(findHostProvidedDependencies({}), []);
    assert.deepEqual(findHostProvidedDependencies({ dependencies: null }), []);
    assert.deepEqual(findHostProvidedDependencies({ dependencies: [] }), []);
  });

  test("this package declares no host-provided dependencies", () => {
    const manifest = JSON.parse(
      readFileSync(new URL("../../package.json", import.meta.url), "utf8")
    );
    assert.deepEqual(findHostProvidedDependencies(manifest), []);
  });
});
