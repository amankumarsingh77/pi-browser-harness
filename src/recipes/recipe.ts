import { parse, stringify } from "yaml";
import { Type } from "typebox";
import { Compile } from "typebox/compile";
import { type Result, err, ok } from "../util/result";
import { isRecord } from "../util/guards";
import type { JsonObject, JsonValue } from "../util/tool";
import type { Locator } from "./journal";
import { REPLAYABLE } from "./recordable";

export type StepExpect = {
  readonly url?: string;
  readonly appeared?: ReadonlyArray<{ readonly role: string; readonly name: string }>;
  readonly dialog?: string;
  readonly download?: boolean;
};

export type RecipeStep = {
  readonly action: string;
  readonly args: JsonObject;
  readonly locator?: Locator;
  readonly expect?: StepExpect;
  readonly fragile?: boolean;
};

export type LastRun = { readonly at: string; readonly result: "ok" | "failed"; readonly step?: number; readonly repairedStep?: number };

export type Recipe = {
  readonly name: string;
  readonly site: string;
  readonly version: number;
  readonly params: Readonly<Record<string, { readonly type: "string"; readonly example: string }>>;
  readonly steps: ReadonlyArray<RecipeStep>;
  readonly recorded: { readonly at: string; readonly session: string };
  readonly lastRun?: LastRun;
};

export const RECIPE_NAME = /^[a-z0-9][a-z0-9-]{0,63}$/;
const PARAM_REF = /\{\{([a-zA-Z_][a-zA-Z0-9_]*)\}\}/g;
const LOCATOR_KEYS: ReadonlySet<string> = new Set(["role", "name", "nth", "css", "x", "y"]);
const STEP_META_KEYS: ReadonlySet<string> = new Set(["expect", "fragile"]);
// For these actions x/y are the tool's own coordinates, not where an element is.
const COORDINATE_ACTIONS: ReadonlySet<string> = new Set(["scroll", "drag_and_drop"]);

// Short action names a recipe may use: every replayable tool except fill_form, which save expands into fills.
const ACTIONS: ReadonlySet<string> = new Set(
  [...REPLAYABLE.keys()].filter((t) => t !== "browser_fill_form").map((t) => t.slice("browser_".length)),
);

const FileSchema = Type.Object({
  name: Type.String({ pattern: RECIPE_NAME.source }),
  site: Type.String({ minLength: 1 }),
  version: Type.Integer({ minimum: 1 }),
  params: Type.Record(Type.String(), Type.Object({ type: Type.Literal("string"), example: Type.String() })),
  steps: Type.Array(Type.Record(Type.String(), Type.Unknown()), { minItems: 1 }),
  recorded: Type.Object({ at: Type.String(), session: Type.String() }),
  last_run: Type.Optional(
    Type.Object({
      at: Type.String(),
      result: Type.Union([Type.Literal("ok"), Type.Literal("failed")]),
      step: Type.Optional(Type.Integer({ minimum: 1 })),
      repaired_step: Type.Optional(Type.Integer({ minimum: 1 })),
    }),
  ),
});
const fileValidator = Compile(FileSchema);

export const paramRefs = (value: string): ReadonlyArray<string> => [...value.matchAll(PARAM_REF)].map((m) => m[1] ?? "");

const isJsonScalar = (v: unknown): v is string | number | boolean =>
  typeof v === "string" || typeof v === "number" || typeof v === "boolean";

const locatorOf = (body: Readonly<Record<string, unknown>>): Locator | undefined => {
  const { role, name, nth, css, x, y } = body;
  if (typeof role === "string" && typeof name === "string") return { role, name, nth: typeof nth === "number" ? nth : 0 };
  if (typeof css === "string") return { css };
  if (typeof x === "number" && typeof y === "number") return { x, y };
  return undefined;
};

const expectOf = (v: unknown): StepExpect | undefined => {
  if (!isRecord(v)) return undefined;
  const appeared = Array.isArray(v["appeared"])
    ? v["appeared"].flatMap((a) => (isRecord(a) && typeof a["role"] === "string" && typeof a["name"] === "string" ? [{ role: a["role"], name: a["name"] }] : []))
    : undefined;
  return {
    ...(typeof v["url"] === "string" ? { url: v["url"] } : {}),
    ...(appeared !== undefined && appeared.length > 0 ? { appeared } : {}),
    ...(typeof v["dialog"] === "string" ? { dialog: v["dialog"] } : {}),
    ...(v["download"] === true ? { download: true } : {}),
  };
};

const decodeStep = (raw: Readonly<Record<string, unknown>>, n: number, declared: ReadonlySet<string>): Result<RecipeStep, string> => {
  const actionKeys = Object.keys(raw).filter((k) => !STEP_META_KEYS.has(k));
  if (actionKeys.length !== 1) return err(`step ${n}: needs exactly one action, found ${actionKeys.length}`);
  const action = actionKeys[0] ?? "";
  if (!ACTIONS.has(action)) return err(`step ${n}: "${action}" is not a replayable action`);
  const body = raw[action] ?? {};
  if (!isRecord(body)) return err(`step ${n}: "${action}" must be a map`);
  const coordinates = COORDINATE_ACTIONS.has(action);
  const args: Record<string, string | number | boolean> = {};
  for (const [k, v] of Object.entries(body)) {
    if (LOCATOR_KEYS.has(k) && !coordinates) continue;
    if (!isJsonScalar(v)) return err(`step ${n}: "${action}.${k}" must be a string, number or boolean`);
    args[k] = v;
  }
  for (const v of Object.values(body)) {
    if (typeof v !== "string") continue;
    const unknown = paramRefs(v).find((p) => !declared.has(p));
    if (unknown !== undefined) return err(`step ${n}: {{${unknown}}} is not a declared param`);
  }
  const locator = coordinates ? undefined : locatorOf(body);
  const expect = expectOf(raw["expect"]);
  return ok({
    action,
    args,
    ...(locator !== undefined ? { locator } : {}),
    ...(expect !== undefined ? { expect } : {}),
    ...(raw["fragile"] === true ? { fragile: true } : {}),
  });
};

// Validates the whole file before anything runs; the first problem is reported with its step number.
export const parseRecipe = (text: string): Result<Recipe, string> => {
  let raw: unknown;
  try {
    raw = parse(text);
  } catch (e) {
    return err(`not valid YAML: ${e instanceof Error ? e.message : String(e)}`);
  }
  if (!fileValidator.Check(raw)) {
    const messages = fileValidator.Errors(raw).map((x) => x.message).join("; ");
    return err(`invalid recipe: ${messages.length > 0 ? messages : "unknown shape"}`);
  }
  const declared = new Set(Object.keys(raw.params));
  const steps: RecipeStep[] = [];
  for (const [i, s] of raw.steps.entries()) {
    const decoded = decodeStep(s, i + 1, declared);
    if (!decoded.success) return decoded;
    steps.push(decoded.data);
  }
  const lr = raw.last_run;
  return ok({
    name: raw.name,
    site: raw.site,
    version: raw.version,
    params: raw.params,
    steps,
    recorded: raw.recorded,
    ...(lr !== undefined
      ? { lastRun: { at: lr.at, result: lr.result, ...(lr.step !== undefined ? { step: lr.step } : {}), ...(lr.repaired_step !== undefined ? { repairedStep: lr.repaired_step } : {}) } }
      : {}),
  });
};

const encodeStep = (s: RecipeStep): Record<string, JsonValue> => ({
  [s.action]: { ...(s.locator ?? {}), ...s.args },
  ...(s.expect !== undefined && Object.keys(s.expect).length > 0 ? { expect: s.expect } : {}),
  ...(s.fragile === true ? { fragile: true } : {}),
});

export const stringifyRecipe = (r: Recipe): string =>
  stringify(
    {
      name: r.name,
      site: r.site,
      version: r.version,
      params: r.params,
      steps: r.steps.map(encodeStep),
      recorded: r.recorded,
      ...(r.lastRun !== undefined
        ? {
            last_run: {
              at: r.lastRun.at,
              result: r.lastRun.result,
              ...(r.lastRun.step !== undefined ? { step: r.lastRun.step } : {}),
              ...(r.lastRun.repairedStep !== undefined ? { repaired_step: r.lastRun.repairedStep } : {}),
            },
          }
        : {}),
    },
    { lineWidth: 0 },
  );
