import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { isRecord } from "../../src/util/guards";

// The daemon is spawned as a separate Node process that resolves modules from the package directory
// upward. pi installs packages with dev and peer dependencies omitted and maps host-provided packages
// (typebox) only inside the extension host, so anything the daemon imports must be a runtime
// dependency of this package or a Node builtin. Issue #34 was `Cannot find module 'typebox'`.
const manifest: unknown = JSON.parse(readFileSync(new URL("../../package.json", import.meta.url), "utf8"));
const RUNTIME_DEPENDENCIES: ReadonlySet<string> = new Set(
  isRecord(manifest) && isRecord(manifest["dependencies"]) ? Object.keys(manifest["dependencies"]) : [],
);

const srcRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

const importSpecifiers = (file: string): ReadonlyArray<string> =>
  [...readFileSync(file, "utf8").matchAll(/^(?:import|export)[^'"\n]*from\s*["']([^'"]+)["']/gm)].map((m) => m[1] ?? "");

const externalImportsReachableFrom = (entry: string): ReadonlyMap<string, string> => {
  const external = new Map<string, string>();
  const seen = new Set<string>();
  const walk = (file: string): void => {
    if (seen.has(file)) return;
    seen.add(file);
    for (const spec of importSpecifiers(file)) {
      if (spec.startsWith(".")) {
        let target = resolve(dirname(file), spec);
        if (!target.endsWith(".ts")) target += ".ts";
        walk(target);
      } else if (!spec.startsWith("node:")) {
        external.set(spec, file.slice(srcRoot.length + 1));
      }
    }
  };
  walk(entry);
  return external;
};

describe("daemon entrypoint imports", () => {
  test("the daemon only reaches runtime dependencies, never host-provided or dev packages", () => {
    const external = externalImportsReachableFrom(join(srcRoot, "daemon", "index.ts"));
    const offenders = [...external].filter(([spec]) => !RUNTIME_DEPENDENCIES.has(spec.split("/")[0] ?? spec));
    assert.deepEqual(
      offenders,
      [],
      `daemon imports packages that are not in "dependencies": ${offenders.map(([s, f]) => `${s} (via ${f})`).join(", ")}`,
    );
  });
});
