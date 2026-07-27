export const isRecord = (v: unknown): v is Readonly<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v);

export const asRecord = (v: unknown): Readonly<Record<string, unknown>> | undefined =>
  isRecord(v) ? v : undefined;

export const asString = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);

export const asNumber = (v: unknown): number | undefined => (typeof v === "number" ? v : undefined);

export const asBoolean = (v: unknown): boolean | undefined => (typeof v === "boolean" ? v : undefined);

export const asArrayOf = <T>(
  v: unknown,
  item: (x: unknown) => T | undefined,
): ReadonlyArray<T> | undefined => {
  if (!Array.isArray(v)) return undefined;
  const out: T[] = [];
  for (const x of v) {
    const parsed = item(x);
    if (parsed === undefined) return undefined;
    out.push(parsed);
  }
  return out;
};

export const errnoCode = (e: unknown): string | undefined => {
  if (!(e instanceof Error) || !("code" in e)) return undefined;
  return asString(e.code);
};
