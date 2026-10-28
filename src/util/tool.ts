import { isRecord } from "./guards";
import { Type, type TSchema, type Static } from "typebox";
import { Compile } from "typebox/compile";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import { type Component, Text } from "@mariozechner/pi-tui";
import { daemonSocketMayExist } from "../daemon/spawn";
import type { BrowserClient } from "../client";
import { type Result, err, ok } from "./result";

// Details are stored by pi as JSON and handed back on replay, so a renderer only ever reads them.
export type DeepReadonly<T> = T extends ReadonlyArray<infer U>
  ? ReadonlyArray<DeepReadonly<U>>
  : T extends object
    ? { readonly [K in keyof T]: DeepReadonly<T[K]> }
    : T;

// pi serializes details to JSON, so a Map, a function or an undefined-valued key would be silently lost or
// mangled on replay; the untyped contract admits only what survives the round trip.
export type JsonValue = string | number | boolean | null | ReadonlyArray<JsonValue> | JsonObject;
export type JsonObject = { readonly [key: string]: JsonValue };

const isJsonValue = (v: unknown): v is JsonValue => {
  if (v === null || typeof v === "string" || typeof v === "number" || typeof v === "boolean") return true;
  if (Array.isArray(v)) return v.every(isJsonValue);
  if (typeof v !== "object" || Object.getPrototypeOf(v) !== Object.prototype) return false;
  return Object.values(v).every(isJsonValue);
};

export const isJsonObject = (v: unknown): v is JsonObject => isRecord(v) && isJsonValue(v);

// A tool that declares no `details` schema may still attach any JSON object for logs; its renderer (if any)
// sees that object untyped, or undefined when the handler attached nothing.
export const UntypedDetailsSchema = Type.Union([Type.Record(Type.String(), Type.Unknown()), Type.Undefined()]);
export type UntypedDetailsSchema = typeof UntypedDetailsSchema;
export type UntypedDetails = JsonObject | undefined;

// The value type a details schema describes, as the handler produces it and the renderer reads it back.
export type DetailsOf<D extends TSchema> = D extends UntypedDetailsSchema ? UntypedDetails : DeepReadonly<Static<D>>;

export type ToolOk<T = UntypedDetails> = {
  readonly text: string;
  readonly details?: T;
};

export type ToolErrKind =
  | "not_connected"
  | "cdp_error"
  | "timeout"
  | "invalid_state"
  | "invalid_args"
  | "io_error"
  | "internal";

export type ToolErr = {
  readonly kind: ToolErrKind;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type HandlerContext<T = UntypedDetails> = {
  readonly client: BrowserClient;
  readonly signal: AbortSignal | undefined;
  readonly onUpdate: (update: ToolOk<T>) => void;
  readonly extensionCtx: ExtensionContext;
};

export type ToolHandler<S extends TSchema, T = UntypedDetails> = (
  args: Static<S>,
  ctx: HandlerContext<T>,
) => Promise<Result<ToolOk<T>, ToolErr>>;

export type ToolConcurrency = "serialized" | "parallel";

// S types the arguments, D the structured details the handler attaches to a successful result. pi persists
// details and hands them back to renderResult on replay; declaring D lets the tool read them back typed, after
// the contract has validated them against the schema. A tool with no details leaves D at its default.
export type BrowserToolDefinition<S extends TSchema, D extends TSchema = UntypedDetailsSchema> = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: ReadonlyArray<string>;
  readonly parameters: S;
  readonly details?: D;
  readonly handler: ToolHandler<S, DetailsOf<D>>;
  readonly renderCall?: (args: Static<S>, theme: Theme) => Component;
  readonly renderResult?: (result: AgentToolResult<DetailsOf<D>>, expanded: boolean, theme: Theme) => Component;
  readonly concurrency: ToolConcurrency;
  readonly ensureAlive?: boolean;
};

// The schema-erased view of a tool. Everything that depends on S or D (handler, renderers, the details
// validator) stays closed over inside `register`, which was built while they were still bound, so no cast is
// needed to hold tools of different schemas in one list.
export type BrowserTool = Pick<
  BrowserToolDefinition<TSchema>,
  "name" | "label" | "description" | "promptSnippet" | "promptGuidelines" | "concurrency" | "ensureAlive"
> & {
  readonly register: (pi: Pick<ExtensionAPI, "registerTool">, client: BrowserClient) => void;
};

// A defined tool is both: tests reach the typed handler and parameters, the registry sees BrowserTool.
export type DefinedBrowserTool<S extends TSchema, D extends TSchema = UntypedDetailsSchema> =
  BrowserToolDefinition<S, D> & BrowserTool;

// pi does not export ToolRenderContext from its index, so it is read off the renderer signature.
type RenderResultContext<S extends TSchema> = Parameters<NonNullable<ToolDefinition<S>["renderResult"]>>[3];

export const renderToolError = (toolName: string, e: ToolErr): string =>
  `${toolName} failed (${e.kind}): ${e.message}`;

// Stored details are whatever the handler attached; the schema (not a marker) is what tells a renderer they
// are usable on replay.
const okResult = <T>(u: ToolOk<T>): AgentToolResult<unknown> => ({
  content: [{ type: "text", text: u.text }],
  details: u.details,
});

const storedText = (result: AgentToolResult<unknown>, fallback: string): string => {
  const first = result.content[0];
  return first?.type === "text" ? first.text : fallback;
};

// Readonly-ness is a compile-time view, so a value the compiled schema accepts is a DetailsOf<D> value. This
// is the one place the predicate is asserted; tools get their details typed through it.
// Compiled once: most tools declare no schema, and compiling the shared fallback per tool is wasted codegen.
const UNTYPED_DETAILS_VALIDATOR = Compile(UntypedDetailsSchema);

const detailsGuard = <D extends TSchema>(schema: D | undefined): ((v: unknown) => v is DetailsOf<D>) => {
  const validator = schema ? Compile(schema) : UNTYPED_DETAILS_VALIDATOR;
  return (v: unknown): v is DetailsOf<D> => validator.Check(v);
};

const notConnected = (message: string): Result<never, ToolErr> =>
  err({ kind: "not_connected", message });

export type CallOutcome = { readonly ok: boolean; readonly error?: string };

// Watches a tool call from outside the tool (the recipe journal). Returns the function that receives the call's
// outcome and may return a note for the end of a successful result, or undefined to skip the call. Errors it throws
// are swallowed by runHandler.
export type CallObserver = (call: {
  readonly name: string;
  readonly concurrency: ToolConcurrency;
  readonly args: unknown;
  readonly client: BrowserClient;
}) => Promise<((outcome: CallOutcome) => Promise<string | undefined>) | undefined>;

let callObserver: CallObserver | undefined;
export const setCallObserver = (o: CallObserver | undefined): void => {
  callObserver = o;
};

const runHandler = async <S extends TSchema, D extends TSchema>(
  def: BrowserToolDefinition<S, D>,
  client: BrowserClient,
  args: Static<S>,
  signal: AbortSignal | undefined,
  onUpdate: ((partial: AgentToolResult<unknown>) => void) | undefined,
  extensionCtx: ExtensionContext,
): Promise<Result<ToolOk<DetailsOf<D>>, ToolErr>> => {
  if (def.ensureAlive !== false) {
    if (!(await daemonSocketMayExist())) {
      return notConnected("Browser harness not initialized. Run /browser-setup first");
    }
    const alive = await client.ensureAlive();
    if (!alive.success) return notConnected(alive.error.message);
  }
  let release: (() => void) | undefined;
  if (def.concurrency !== "parallel") {
    release = await client.mutationMutex().acquire();
    if (signal?.aborted) {
      release();
      return err({ kind: "invalid_state", message: "Tool execution aborted before entering serialized lane" });
    }
  }
  const finish = await callObserver?.({ name: def.name, concurrency: def.concurrency, args, client }).catch(() => undefined);
  try {
    const result = await def.handler(args, {
      client,
      signal,
      onUpdate: (u) => onUpdate?.(okResult(u)),
      extensionCtx,
    });
    const note = await finish?.(result.success ? { ok: true } : { ok: false, error: result.error.message }).catch(() => undefined);
    return result.success && note !== undefined ? ok({ ...result.data, text: `${result.data.text}\n\n${note}` }) : result;
  } catch (e) {
    // A throw is a bug in the handler, not a tool outcome; it still has to reach the model as an error.
    const message = e instanceof Error ? e.message : String(e);
    await finish?.({ ok: false, error: message }).catch(() => undefined);
    return err({ kind: "internal", message });
  } finally {
    release?.();
  }
};

// pi has no error field on a resolved tool result: the agent loop marks a result isError only when
// execute rejects, and then stores the thrown message as the result text. So a failed handler throws.
const toPiTool = <S extends TSchema, D extends TSchema>(
  def: BrowserToolDefinition<S, D>,
  client: BrowserClient,
): ToolDefinition<S> => {
  const defRenderCall = def.renderCall;
  const defRenderResult = def.renderResult;
  const isDetails = detailsGuard(def.details);
  return {
    name: def.name,
    label: def.label,
    description: def.description,
    promptSnippet: def.promptSnippet,
    promptGuidelines: [...def.promptGuidelines],
    parameters: def.parameters,
    ...(defRenderCall
      ? { renderCall: (args: Static<S>, theme: Theme) => defRenderCall(args, theme) }
      : {}),
    ...(defRenderResult
      ? {
          renderResult: (
            result: AgentToolResult<unknown>,
            options: ToolRenderResultOptions,
            theme: Theme,
            ctx: RenderResultContext<S>,
          ) => {
            // A replayed error carries only the thrown text (details are empty), so the tool's own renderer never sees it.
            if (ctx.isError) {
              const text = storedText(result, `${def.name} failed (internal): unknown error`);
              return new Text(theme.fg("error", text), 0, 0);
            }
            // Replayed details may predate the schema (older session, changed shape); then the stored text stands in.
            const details: unknown = result.details;
            if (!isDetails(details)) return new Text(storedText(result, ""), 0, 0);
            return defRenderResult({ ...result, details }, options.expanded, theme);
          },
        }
      : {}),
    async execute(_toolCallId, args, signal, onUpdate, extensionCtx) {
      const result = await runHandler(def, client, args, signal, onUpdate, extensionCtx);
      if (!result.success) throw new Error(renderToolError(def.name, result.error));
      return okResult(result.data);
    },
  };
};

export const defineBrowserTool = <S extends TSchema, D extends TSchema = UntypedDetailsSchema>(
  def: BrowserToolDefinition<S, D>,
): DefinedBrowserTool<S, D> => ({
  ...def,
  register: (pi, client) => {
    pi.registerTool(toPiTool(def, client));
  },
});
