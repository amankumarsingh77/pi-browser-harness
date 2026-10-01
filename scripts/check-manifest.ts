// Mirrors HOST_PROVIDED_EXTENSION_PACKAGES in pi-coding-agent's
// resource-loader.js and the list in its docs/packages.md. Pi provides these
// packages to extensions at runtime; declaring them in dependencies makes pi
// emit an extension warning and risks duplicate runtime modules.
export const HOST_PROVIDED_EXTENSION_PACKAGES: ReadonlySet<string> = new Set([
  "@earendil-works/pi-agent-core",
  "@earendil-works/pi-ai",
  "@earendil-works/pi-coding-agent",
  "@earendil-works/pi-tui",
  "@mariozechner/pi-agent-core",
  "@mariozechner/pi-ai",
  "@mariozechner/pi-coding-agent",
  "@mariozechner/pi-tui",
  "@sinclair/typebox",
  "typebox",
]);

export type Manifest = {
  readonly dependencies?: unknown;
  readonly peerDependencies?: unknown;
  readonly devDependencies?: unknown;
};

// A host-provided package belongs in peerDependencies with a "*" range only.
export function findHostProvidedDependencies(
  manifest: Manifest
): ReadonlyArray<string> {
  const dependencies = manifest.dependencies;
  if (
    typeof dependencies !== "object" ||
    dependencies === null ||
    Array.isArray(dependencies)
  ) {
    return [];
  }
  const names = Object.keys(dependencies).filter((name) =>
    HOST_PROVIDED_EXTENSION_PACKAGES.has(name)
  );
  return names.sort();
}
