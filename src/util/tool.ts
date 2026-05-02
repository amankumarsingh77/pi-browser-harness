import type { TSchema, Static } from "typebox";
import type {
  AgentToolResult,
  AgentToolUpdateCallback,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import type { BrowserClient } from "../client";
import type { Result } from "./result";

export type ToolOk = {
  readonly text: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type ToolErrKind =
  | "not_connected"
  | "cdp_error"
  | "timeout"
  | "invalid_state"
  | "io_error"
  | "internal";

export type ToolErr = {
  readonly kind: ToolErrKind;
  readonly message: string;
  readonly details?: Readonly<Record<string, unknown>>;
};

export type HandlerContext = {
  readonly client: BrowserClient;
  readonly signal: AbortSignal | undefined;
  readonly onUpdate: (update: ToolOk) => void;
  readonly extensionCtx: ExtensionContext;
};

export type ToolHandler<S extends TSchema> = (
  args: Static<S>,
  ctx: HandlerContext,
) => Promise<Result<ToolOk, ToolErr>>;

export type BrowserToolDefinition<S extends TSchema> = {
  readonly name: string;
  readonly label: string;
  readonly description: string;
  readonly promptSnippet: string;
  readonly promptGuidelines: ReadonlyArray<string>;
  readonly parameters: S;
  readonly handler: ToolHandler<S>;
  readonly renderCall?: (args: Static<S>, theme: Theme) => Component;
  readonly renderResult?: (result: AgentToolResult<unknown>, expanded: boolean, theme: Theme) => Component;
  readonly ensureAlive?: boolean;
};

// Type-erased entry for arrays. AnyBrowserToolDefinition lets the registry
// hold a heterogeneous list without losing the per-tool Static<S> binding.
export type AnyBrowserToolDefinition = BrowserToolDefinition<TSchema>;

export const defineBrowserTool = <S extends TSchema>(
  def: BrowserToolDefinition<S>,
): BrowserToolDefinition<S> => def;

type OkDetails = { readonly ok: true } & Readonly<Record<string, unknown>>;
type ErrDetails = { readonly ok: false; readonly kind: ToolErrKind; readonly message: string } & Readonly<Record<string, unknown>>;

const toToolResult = (
  r: Result<ToolOk, ToolErr>,
  toolName: string,
): AgentToolResult<OkDetails | ErrDetails> => {
  if (r.success) {
    const details: OkDetails = { ok: true, ...(r.data.details ?? {}) };
    return {
      content: [{ type: "text", text: r.data.text }],
      details,
    };
  }
  const details: ErrDetails = {
    ok: false,
    kind: r.error.kind,
    message: r.error.message,
    ...(r.error.details ?? {}),
  };
  return {
    // isError is an extension the pi-coding-agent runtime picks up from the result object;
    // AgentToolResult<T> itself doesn't declare it but the runtime reads it via duck-typing.
    // We cast through unknown to avoid widening the return type.
    ...(({ isError: true }) as unknown as object),
    content: [{ type: "text", text: `${toolName} failed (${r.error.kind}): ${r.error.message}` }],
    details,
  };
};

export const registerBrowserTool = <S extends TSchema>(
  pi: ExtensionAPI,
  client: BrowserClient,
  def: BrowserToolDefinition<S>,
): void => {
  const td: ToolDefinition<S> = {
    name: def.name,
    label: def.label,
    description: def.description,
    promptSnippet: def.promptSnippet,
    promptGuidelines: [...def.promptGuidelines],
    parameters: def.parameters,
    ...(def.renderCall
      ? {
          renderCall: (args: Static<S>, theme: Theme, _ctx: Parameters<NonNullable<ToolDefinition<S>["renderCall"]>>[2]) =>
            // Non-null assertion safe: this branch only runs when renderCall was provided.
            def.renderCall!(args, theme),
        }
      : {}),
    ...(def.renderResult
      ? {
          renderResult: (
            result: AgentToolResult<unknown>,
            options: ToolRenderResultOptions,
            theme: Theme,
            _ctx: Parameters<NonNullable<ToolDefinition<S>["renderResult"]>>[3],
          ) =>
            // Non-null assertion safe: this branch only runs when renderResult was provided.
            def.renderResult!(result, options.expanded ?? false, theme),
        }
      : {}),
    async execute(_toolCallId, args, signal, onUpdate, extensionCtx) {
      if (def.ensureAlive !== false) {
        const alive = await client.ensureAlive();
        if (!alive.success) {
          return toToolResult(
            { success: false, error: { kind: "not_connected", message: alive.error.message } },
            def.name,
          );
        }
      }
      const result = await def.handler(args, {
        client,
        signal,
        onUpdate: (u) => {
          if (onUpdate) {
            // AgentToolUpdateCallback expects AgentToolResult<TDetails>; we use unknown for TDetails.
            const update: AgentToolResult<OkDetails> = {
              content: [{ type: "text", text: u.text }],
              details: { ok: true, ...(u.details ?? {}) },
            };
            // Cast needed: onUpdate is AgentToolUpdateCallback<unknown> (generic TDetails).
            (onUpdate as AgentToolUpdateCallback<OkDetails>)(update);
          }
        },
        extensionCtx,
      });
      return toToolResult(result, def.name);
    },
  };
  pi.registerTool(td);
};
