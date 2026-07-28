export type Exemption = {
  readonly path: string;
  readonly rule: string;
  readonly count: number;
  readonly reason: string;
};

export const ALLOWLIST: ReadonlyArray<Exemption> = [
  {
    path: "src/util/sharp-shim.ts",
    rule: "inline-object-cast",
    count: 1,
    reason:
      "sharp is an optional dependency resolved by a dynamic import, so its shape is unknown at compile time; the cast only claims an optional .default and every value read off it is re-checked with typeof before use",
  },
];
