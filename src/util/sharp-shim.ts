// `sharp` is an optional dependency not installed in every workspace, so the import must stay dynamic and unresolvable to tsc.

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

const SHARP_SPECIFIER: string = "sharp";

const MISSING_MODULE_MARKERS: ReadonlyArray<string> = [
  "Cannot find module",
  "MODULE_NOT_FOUND",
  "ERR_MODULE_NOT_FOUND",
];

export const loadSharp = async (): Promise<SharpLoad> => {
  let mod: unknown;
  try {
    mod = await import(SHARP_SPECIFIER);
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (MISSING_MODULE_MARKERS.some((marker) => msg.includes(marker))) return { kind: "missing" };
    return { kind: "error", message: msg };
  }
  if (mod === null || mod === undefined) return { kind: "missing" };
  // The CommonJS sharp module's default export IS the factory; ESM-wrapped sharp puts it on .default.
  const m = mod as { default?: unknown };
  const candidate: unknown = typeof m.default === "function" ? m.default : mod;
  if (typeof candidate !== "function") {
    return { kind: "error", message: "sharp module did not expose a callable factory" };
  }
  return { kind: "ok", sharp: candidate as SharpFactory };
};
