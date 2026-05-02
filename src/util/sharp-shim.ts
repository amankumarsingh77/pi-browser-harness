// Typed minimal shim for the optional `sharp` dependency. Sharp is a heavy
// native module not installed in every workspace; we import dynamically and
// distinguish "missing" (no install) from "error" (installed but threw).
//
// We declare only the surface we use. The dynamic import returns `unknown`
// at the boundary; the cast inside loadSharp() is the documented escape
// hatch — every other consumer sees the typed SharpFactory.

export type SharpInstance = {
  metadata(): Promise<{ width?: number; height?: number }>;
  composite(layers: ReadonlyArray<{ input: Buffer; top: number; left: number }>): SharpInstance;
  resize(width: number, height: number, opts?: { fit?: "inside" }): SharpInstance;
  toFile(path: string): Promise<unknown>;
};

export type SharpFactory = (input: string | Buffer) => SharpInstance;

export type SharpLoad =
  | { readonly kind: "ok"; readonly sharp: SharpFactory }
  | { readonly kind: "missing" }
  | { readonly kind: "error"; readonly message: string };

export const loadSharp = async (): Promise<SharpLoad> => {
  let mod: unknown;
  try {
    // sharp is an optional dependency; it may not be installed.
    // @ts-ignore — optional peer dependency not required at compile time
    mod = await import("sharp");
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (
      msg.includes("Cannot find module") ||
      msg.includes("MODULE_NOT_FOUND") ||
      msg.includes("ERR_MODULE_NOT_FOUND")
    ) {
      return { kind: "missing" };
    }
    return { kind: "error", message: msg };
  }
  if (mod === null || mod === undefined) return { kind: "missing" };
  // The CommonJS sharp module's default export IS the factory. ESM-wrapped
  // sharp puts it on .default. Probe both.
  const m = mod as { default?: unknown };
  const candidate: unknown = typeof m.default === "function" ? m.default : mod;
  if (typeof candidate !== "function") {
    return { kind: "error", message: "sharp module did not expose a callable factory" };
  }
  return { kind: "ok", sharp: candidate as SharpFactory };
};
