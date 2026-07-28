import type { BrowserClient } from "../client";
import { safeJs } from "../util/js-template";
import { type Result, err, ok } from "../util/result";
import type { ToolErr } from "../util/tool";
import { cdpCall, evalJs } from "./cdp-call";
import { resolveRefToObjectId } from "./ref-resolve";

export type PageResult = {
  readonly ok: boolean;
  readonly reason?: string;
  readonly kind?: string;
  readonly value?: unknown;
  readonly text?: string;
  readonly checked?: boolean;
  readonly changed?: boolean;
  readonly tag?: string;
  readonly options?: ReadonlyArray<{ value: string; text: string }>;
};

const isOption = (v: unknown): v is { readonly value: string; readonly text: string } =>
  typeof v === "object" && v !== null
  && "value" in v && typeof v.value === "string"
  && "text" in v && typeof v.text === "string";

export const isPageResult = (v: unknown): v is PageResult => {
  if (typeof v !== "object" || v === null) return false;
  if (!("ok" in v) || typeof v.ok !== "boolean") return false;
  if ("reason" in v && typeof v.reason !== "string") return false;
  if ("kind" in v && typeof v.kind !== "string") return false;
  if ("text" in v && typeof v.text !== "string") return false;
  if ("checked" in v && typeof v.checked !== "boolean") return false;
  if ("changed" in v && typeof v.changed !== "boolean") return false;
  if ("tag" in v && typeof v.tag !== "string") return false;
  if ("options" in v && !(Array.isArray(v.options) && v.options.every(isOption))) return false;
  return true;
};

export const runOnElement = async (
  client: BrowserClient,
  opts: {
    ref?: string | undefined;
    selector?: string | undefined;
    fnBody: string;
    arg: unknown;
    notFound?: unknown;
  },
): Promise<Result<unknown, ToolErr>> => {
  if (opts.ref !== undefined) {
    const objectId = await resolveRefToObjectId(client, opts.ref);
    if (!objectId.success) return objectId;
    const r = await cdpCall(client, "Runtime.callFunctionOn", {
      objectId: objectId.data,
      functionDeclaration: `function (arg) { ${opts.fnBody} }`,
      arguments: [{ value: opts.arg }],
      returnByValue: true,
    });
    if (!r.success) return r;
    if (r.data.exceptionDetails !== undefined) {
      return err({
        kind: "cdp_error",
        message: `page function threw: ${r.data.exceptionDetails.text}`,
        details: { ref: opts.ref },
      });
    }
    return ok(r.data.result.value);
  }
  if (opts.selector === undefined) {
    return err({ kind: "invalid_state", message: "Provide either `ref` or `selector`." });
  }
  // fnBody is harness-authored, not user input; only the selector and value are interpolated, and those go through safeJs.
  const prelude = safeJs`
    (() => {
      const el = document.querySelector(${opts.selector});
      if (!el) return ${opts.notFound ?? { status: "not_found" }};
      const __arg = ${opts.arg};
      return (function (arg) {`;
  const expr = `${prelude} ${opts.fnBody} }).call(el, __arg); })()`;
  const r = await evalJs(client, expr);
  if (!r.success) return r;
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
  const handle = objectId.data;
  try {
    const called = await cdpCall(client, "Runtime.callFunctionOn", {
      objectId: handle,
      functionDeclaration,
      arguments: args.map((v) => ({ value: v })),
      returnByValue: true,
      awaitPromise: true,
    });
    if (!called.success) return err({ ...called.error, details: { ref } });
    if (called.data.exceptionDetails !== undefined) {
      return err({ kind: "cdp_error", message: `page function threw: ${JSON.stringify(called.data.exceptionDetails)}`, details: { ref } });
    }
    const value = called.data.result.value;
    if (!isPageResult(value)) {
      return err({ kind: "internal", message: "page function returned no result object", details: { ref } });
    }
    return ok(value);
  } finally {
    await cdpCall(client, "Runtime.releaseObject", { objectId: handle });
  }
};

export const detailsOf = (ref: string, res: PageResult, extra?: Readonly<Record<string, unknown>>): Readonly<Record<string, unknown>> => {
  const { ok: _ok, ...rest } = res;
  return { ref, ...rest, ...(extra ?? {}) };
};
