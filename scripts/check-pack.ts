// Packed-install smoke test for the npm release.
//
// Regression guard for browser-use/browser-harness#808: the 0.11.0 release
// shipped without `tsx` in `dependencies`, so the daemon could not start in
// locked-down environments (npx could not fetch tsx, the IPC socket was never
// created, `/browser-setup` failed with "socket not found"). The source was
// fixed afterwards, but nothing checks the *packed* artifact before release —
// `npm pack` copies package.json verbatim, so a dependency dropped from
// `dependencies` (or never added) sails straight into the published tarball.
//
// This script closes that gap: it packs the package, asserts the tarball's
// manifest declares every runtime dependency the daemon needs, installs the
// tarball into a clean directory, and proves the daemon's own tsx resolution
// (`resolveTsxCliFromFilesystem` from src/daemon/spawn.ts) succeeds against
// the installed tree. Wired into CI in place of `npm pack --dry-run`.

import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTsxCliFromFilesystem } from "../src/daemon/spawn";

const repoRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export type PackedManifest = {
  readonly dependencies?: unknown;
};

// Every package the daemon needs at runtime, with the code that needs it.
// These must stay in `dependencies` (not devDependencies): the packed tarball
// is installed by end users, and anything the daemon resolves at startup has
// to be installable from the published metadata.
export const RUNTIME_DEPS: ReadonlyArray<string> = [
  // src/daemon/spawn.ts resolves `tsx/cli` to launch the daemon script.
  "tsx",
  // src/daemon/* imports `ws` for the CDP WebSocket transport.
  "ws",
];

// Returns the runtime deps missing from a packed package.json's
// `dependencies` — the exact defect that produced the 0.11.0 release.
export function findMissingRuntimeDeps(
  manifest: PackedManifest
): ReadonlyArray<string> {
  const dependencies = manifest.dependencies;
  if (typeof dependencies !== "object" || dependencies === null || Array.isArray(dependencies)) {
    return [...RUNTIME_DEPS];
  }
  const declared = new Set(Object.keys(dependencies));
  return RUNTIME_DEPS.filter((name) => !declared.has(name));
}

const run = (cmd: string, args: ReadonlyArray<string>, cwd: string): string =>
  execFileSync(cmd, [...args], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

export const main = (): void => {
  const packDir = mkdtempSync(join(tmpdir(), "pi-browser-harness-pack-"));
  const installDir = mkdtempSync(join(tmpdir(), "pi-browser-harness-install-"));
  try {
    // 1. Pack for real (not --dry-run): this is the artifact npm publishes.
    const tarballName = run("npm", ["pack", "--pack-destination", packDir, "--silent"], repoRoot).trim();
    const tarball = join(packDir, tarballName);

    // 2. The published metadata must declare every runtime dependency.
    const packedManifest = JSON.parse(
      run("tar", ["-xOzf", tarball, "package/package.json"], packDir)
    ) as PackedManifest;
    const missing = findMissingRuntimeDeps(packedManifest);
    if (missing.length > 0) {
      console.error(
        `pack check: FAIL — packed package.json is missing runtime dependencies: ${missing.join(", ")}. ` +
          `The daemon cannot start from a clean install without them (see browser-use/browser-harness#808).`
      );
      process.exitCode = 1;
      return;
    }
    console.log(`pack check: tarball manifest declares runtime deps (${RUNTIME_DEPS.join(", ")})`);

    // 3. Clean-install the tarball and prove the daemon can resolve tsx from
    //    the installed tree — the resolution the 0.11.0 release failed at.
    run("npm", ["install", "--no-audit", "--no-fund", "--silent", tarball], installDir);
    const installedDaemonDir = join(installDir, "node_modules", "pi-browser-harness", "src", "daemon");
    const tsxCli = resolveTsxCliFromFilesystem(installedDaemonDir);
    if (!tsxCli) {
      console.error(
        `pack check: FAIL — tsx CLI not resolvable from a clean install of the packed tarball. ` +
          `The daemon would fail to start (see browser-use/browser-harness#808).`
      );
      process.exitCode = 1;
      return;
    }
    console.log(`pack check: clean install resolves tsx CLI (${tsxCli})`);
    console.log("pack check: PASS");
  } finally {
    rmSync(packDir, { recursive: true, force: true });
    rmSync(installDir, { recursive: true, force: true });
  }
};

if (process.argv[1]?.endsWith("check-pack.ts")) main();
