import { isRecord } from "../util/guards";
import type { BrowserClient } from "../client";
import { safeJs } from "../util/js-template";
import { type Result, err, ok } from "../util/result";
import type { JsonObject, ToolErr } from "../util/tool";
import { cdpCall, evalJs } from "./cdp-call";
import type { PageOption, PageResult } from "./page/fill.page";
import { resolveRefToObjectId } from "./ref-resolve";

// PageResult is declared once, in the page module that produces it (page/fill.page.ts), so the guard below is checked
// against the same declaration the page function returns.
export type { PageOption, PageResult };

const isOption = (v: unknown): v is PageOption =>
  typeof v === "object" && v !== null
  && "value" in v && typeof v.value === "string"
  && "text" in v && typeof v.text === "string";

const hasTag = (v: object): v is { readonly tag: string } => "tag" in v && typeof v.tag === "string";

export const isPageResult = (v: unknown): v is PageResult => {
  if (typeof v !== "object" || v === null) return false;
  if (!("ok" in v) || typeof v.ok !== "boolean") return false;
  if (!v.ok) {
    if (!("reason" in v) || typeof v.reason !== "string") return false;
    if ("tag" in v && typeof v.tag !== "string") return false;
    if ("code" in v && v.code !== "select_rejected" && v.code !== "no_match") return false;
    if ("options" in v && !(Array.isArray(v.options) && v.options.every(isOption))) return false;
    return true;
  }
  if (!("kind" in v) || typeof v.kind !== "string" || !hasTag(v)) return false;
  switch (v.kind) {
    case "select":
      return "value" in v && typeof v.value === "string" && "text" in v && typeof v.text === "string";
    case "checkbox":
    case "radio":
      return "checked" in v && typeof v.checked === "boolean" && "changed" in v && typeof v.changed === "boolean";
    case "input":
    case "textarea":
    case "contenteditable":
      return "value" in v && typeof v.value === "string";
    default:
      return false;
  }
};

// The one not-found shape for element lookups: the page never reports it, the harness does.
export type ElementOutcome =
  | { readonly found: false }
  | { readonly found: true; readonly value: unknown };

const isElementOutcome = (v: unknown): v is ElementOutcome => {
  if (!isRecord(v)) return false;
  if (v["found"] === false) return true;
  return v["found"] === true && "value" in v;
};

const callOnObject = async (
  client: BrowserClient,
  objectId: string,
  functionDeclaration: string,
  args: ReadonlyArray<unknown>,
  ref: string,
): Promise<Result<unknown, ToolErr>> => {
  try {
    const called = await cdpCall(client, "Runtime.callFunctionOn", {
      objectId,
      functionDeclaration,
      arguments: args.map((v) => ({ value: v })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (!called.success) return err({ ...called.error, details: { ...(called.error.details ?? {}), ref } });
    if (called.data.exceptionDetails !== undefined) {
      return err({ kind: "cdp_error", message: `page function threw: ${JSON.stringify(called.data.exceptionDetails)}`, details: { ref } });
    }
    return ok(called.data.result.value);
  } finally {
    await cdpCall(client, "Runtime.releaseObject", { objectId });
  }
};

// Runs an element function (its declaration from page/inject.ts elementFunctionSource) on the element a ref or
// selector names. A ref goes through Runtime.callFunctionOn; a selector is looked up in one Runtime.evaluate round trip.
export const runOnElement = async (
  client: BrowserClient,
  opts: {
    ref?: string | undefined;
    selector?: string | undefined;
    functionDeclaration: string;
    args: ReadonlyArray<unknown>;
  },
): Promise<Result<ElementOutcome, ToolErr>> => {
  if (opts.ref !== undefined) {
    const objectId = await resolveRefToObjectId(client, opts.ref);
    if (!objectId.success) return objectId;
    const r = await callOnObject(client, objectId.data, opts.functionDeclaration, opts.args, opts.ref);
    if (!r.success) return r;
    return ok({ found: true, value: r.data });
  }
  if (opts.selector === undefined) {
    return err({ kind: "invalid_args", message: "Provide either `ref` or `selector`." });
  }
  // The function source is harness-authored, not user input; only the selector and the arguments are interpolated,
  // and those go through safeJs.
  const prelude = safeJs`
    (() => {
      const el = document.querySelector(${opts.selector});
      if (!el) return { found: false };
      const __args = ${opts.args};
      return { found: true, value: (`;
  const expr = prelude + opts.functionDeclaration + ").apply(el, __args) }; })()";
  const r = await evalJs(client, expr);
  if (!r.success) return r;
  if (!isElementOutcome(r.data)) {
    return err({ kind: "internal", message: "unexpected page result shape from element lookup", details: { selector: opts.selector } });
  }
  return ok(r.data);
};

export const resolveAndCall = async (
  client: BrowserClient,
  ref: string,
  functionDeclaration: string,
  args: ReadonlyArray<unknown>,
): Promise<Result<PageResult, ToolErr>> => {
  const objectId = await resolveRefToObjectId(client, ref);
  if (!objectId.success) return objectId;
  const r = await callOnObject(client, objectId.data, functionDeclaration, args, ref);
  if (!r.success) return r;
  if (!isPageResult(r.data)) {
    return err({ kind: "internal", message: "unexpected page result shape", details: { ref } });
  }
  return ok(r.data);
};

// The page result minus its `ok` flag (the caller has already branched on it), as JSON for a tool's details.
export const detailsOf = (ref: string, res: PageResult): JsonObject => {
  if (!res.ok) {
    return {
      ref,
      reason: res.reason,
      ...(res.tag !== undefined ? { tag: res.tag } : {}),
      ...(res.code !== undefined ? { code: res.code } : {}),
      ...(res.options !== undefined ? { options: res.options } : {}),
    };
  }
  if ("checked" in res) return { ref, kind: res.kind, checked: res.checked, changed: res.changed, tag: res.tag };
  if (res.kind === "select") return { ref, kind: res.kind, value: res.value, text: res.text, tag: res.tag };
  return { ref, kind: res.kind, value: res.value, tag: res.tag };
};
