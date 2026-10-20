// `sharp` is an optional dependency not installed in every workspace, so the import must stay dynamic and unresolvable to tsc.

import { errnoCode, isRecord } from "./guards";

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

// Kept as a variable so the bundler does not try to resolve the optional dependency statically.
const SHARP_SPECIFIER = "sharp";

// Node reports an absent package through the error code: ERR_MODULE_NOT_FOUND from the ESM loader
// ("Cannot find package 'sharp' imported from …"), MODULE_NOT_FOUND from require. Matching the message
// text misses the ESM form, so an uninstalled sharp used to be reported as a load failure.
const MISSING_MODULE_CODES: ReadonlySet<string> = new Set(["ERR_MODULE_NOT_FOUND", "MODULE_NOT_FOUND"]);

export const classifySharpImportFailure = (e: unknown): SharpLoad => {
  const code = errnoCode(e);
  if (code !== undefined && MISSING_MODULE_CODES.has(code)) return { kind: "missing" };
  return { kind: "error", message: e instanceof Error ? e.message : String(e) };
};

export const loadSharp = async (): Promise<SharpLoad> => {
  let mod: unknown;
  try {
    mod = await import(SHARP_SPECIFIER);
  } catch (e) {
    return classifySharpImportFailure(e);
  }
  if (mod === null || mod === undefined) return { kind: "missing" };
  // The CommonJS sharp module's default export IS the factory; ESM-wrapped sharp puts it on .default.
  const candidate: unknown = isRecord(mod) && typeof mod["default"] === "function" ? mod["default"] : mod;
  if (typeof candidate !== "function") {
    return { kind: "error", message: "sharp module did not expose a callable factory" };
  }
  // The only thing verifiable at runtime is that sharp exported a function; its signature is taken on trust.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- optional-dependency boundary, see scripts/boundary-allowlist.ts
  return { kind: "ok", sharp: candidate as SharpFactory };
};
