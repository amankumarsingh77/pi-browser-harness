// Runs on every OS in the CI matrix on purpose: `isPathWithin` delegates to `node:path`, so
// only a real Windows run proves the backslash and drive-letter-case cases the old check failed.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { tmpdir } from "node:os";
import { join, resolve, sep } from "node:path";
import { isPathWithin } from "../../src/util/paths";

const root = resolve(tmpdir());

describe("path containment", () => {
  test("a directory contains itself", () => {
    assert.equal(isPathWithin(root, root), true);
  });

  test("a direct child is contained", () => {
    assert.equal(isPathWithin(root, join(root, "script.js")), true);
  });

  test("a nested child is contained", () => {
    assert.equal(isPathWithin(root, join(root, "a", "b", "script.js")), true);
  });

  test("a native-separator path is contained", () => {
    assert.equal(isPathWithin(root, `${root}${sep}script.js`), true);
  });

  test("an unnormalised path that still lands inside is contained", () => {
    assert.equal(isPathWithin(root, join(root, "a", "..", "script.js")), true);
  });

  test("an unnormalised path that escapes the root is rejected", () => {
    assert.equal(isPathWithin(root, join(root, "..", "..", "evil.js")), false);
  });

  test("a sibling directory sharing the root's name prefix is rejected", () => {
    assert.equal(isPathWithin(root, `${root}-sibling${sep}script.js`), false);
  });

  test("the root's own parent is rejected", () => {
    assert.equal(isPathWithin(root, join(root, "..")), false);
  });

  test("the roots the run-script tool allows accept a file written into them", () => {
    for (const allowed of [tmpdir(), process.cwd()]) {
      assert.equal(isPathWithin(allowed, join(allowed, "bh-script.mjs")), true, allowed);
    }
  });
});
