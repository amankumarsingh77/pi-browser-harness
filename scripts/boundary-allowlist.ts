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
  {
    path: "src/util/sharp-shim.ts",
    rule: "named-cast",
    count: 1,
    reason:
      "the same optional-dependency boundary: candidate is narrowed to a callable by a typeof check on the line above before it is claimed to be a SharpFactory",
  },
  {
    path: "src/cdp/commands.ts",
    rule: "named-cast",
    count: 1,
    reason:
      "the sanctioned CDP result decoder; guarded by the validate.Check on the preceding line, and unavoidable because a generic key cannot correlate with its mapped value type",
  },
  {
    path: "src/cdp/events.ts",
    rule: "named-cast",
    count: 1,
    reason:
      "the sanctioned CDP event decoder; same guarded Check and same generic-correlation limit as cdp/commands.ts",
  },
  {
    path: "src/util/tool.ts",
    rule: "function-cast",
    count: 1,
    reason:
      "renderCall is stored under a per-tool Static<S> but invoked through the erased TSchema form; the generic-correlation limit makes this unavoidable and the value is the tool's own handler, created with the same S",
  },
  {
    path: "src/domains/cdp-call.ts",
    rule: "raw-cdp-call",
    count: 3,
    reason:
      "the one door from a tool to CDP: cdpCall, cdpCallOnTarget and cdpCallBrowser each reach the session once and map CdpError to ToolErr, so no other file under src/domains needs to",
  },
  {
    path: "src/domains/cdp-call.ts",
    rule: "raw-evaluate",
    count: 1,
    reason: "evalJs is the single wrapper over client.evaluateJs, for the same reason",
  },
  {
    path: "src/domains/js.ts",
    rule: "trailing-cast",
    count: 1,
    reason:
      "the AsyncFunction constructor is reached through Object.getPrototypeOf, which returns any; the cast restores the constructor signature that a plain unknown would lose",
  },
];
