import type { TSchema, Static } from "typebox";
import type {
  AgentToolResult,
  ExtensionAPI,
  ExtensionContext,
  Theme,
  ToolDefinition,
  ToolRenderResultOptions,
} from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { access } from "node:fs/promises";
import { DAEMON_SOCKET_PATH } from "../daemon/protocol";
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
  readonly concurrency: "serialized" | "parallel";
  readonly ensureAlive?: boolean;
};

// Type-erased entry for the registry's heterogeneous TOOLS array.
// renderCall accepts `never` so any concrete args type satisfies it via
// function-parameter contravariance (a handler that takes SpecificT is
// assignable to one that takes never, because never is a subtype of everything).
export type AnyBrowserToolDefinition = Omit<BrowserToolDefinition<TSchema>, "renderCall" | "renderResult"> & {
  readonly renderCall?: (args: never, theme: Theme) => Component;
  readonly renderResult?: (result: AgentToolResult<unknown>, expanded: boolean, theme: Theme) => Component;
};

export const defineBrowserTool = <S extends TSchema>(
  def: BrowserToolDefinition<S>,
): BrowserToolDefinition<S> => def;

type OkDetails = { readonly ok: true } & Readonly<Record<string, unknown>>;
type ErrDetails = { readonly ok: false; readonly kind: ToolErrKind; readonly message: string } & Readonly<Record<string, unknown>>;

type ErrorFlagged<D> = AgentToolResult<D> & { readonly isError?: boolean };

const toToolResult = (
  r: Result<ToolOk, ToolErr>,
  toolName: string,
): ErrorFlagged<OkDetails | ErrDetails> => {
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
    isError: true,
    content: [{ type: "text", text: `${toolName} failed (${r.error.kind}): ${r.error.message}` }],
    details,
  };
};

export const registerBrowserTool = (
  pi: ExtensionAPI,
  client: BrowserClient,
  def: AnyBrowserToolDefinition,
): void => {
  // AnyBrowserToolDefinition is type-erased; we recover the schema-typed surface
  // by casting def to the generic form. The cast is safe because defineBrowserTool
  // ensures the handler, parameters, and renderCall were all created with the same S.
  type S = TSchema;
  const defRenderCall = def.renderCall;
  const defRenderResult = def.renderResult;
  const td: ToolDefinition<S> = {
    name: def.name,
    label: def.label,
    description: def.description,
    promptSnippet: def.promptSnippet,
    promptGuidelines: [...def.promptGuidelines],
    parameters: def.parameters,
    ...(defRenderCall
      ? {
          renderCall: (args: Static<S>, theme: Theme, _ctx: Parameters<NonNullable<ToolDefinition<S>["renderCall"]>>[2]) =>
            // Cast from never->Component to unknown->Component: safe because at runtime
            // args is always the concrete Static<S> value the tool was defined with.
            (defRenderCall as (args: unknown, theme: Theme) => Component)(args, theme),
        }
      : {}),
    ...(defRenderResult
      ? {
          renderResult: (
            result: AgentToolResult<unknown>,
            options: ToolRenderResultOptions,
            theme: Theme,
            _ctx: Parameters<NonNullable<ToolDefinition<S>["renderResult"]>>[3],
          ) => defRenderResult(result, options.expanded ?? false, theme),
        }
      : {}),
    async execute(_toolCallId, args, signal, onUpdate, extensionCtx) {
      if (def.ensureAlive !== false) {
        // Check daemon socket exists before attempting browser control.
        // If missing, the user hasn't run /browser-setup yet. Return a clear
        // error so the agent knows to direct the user to initialize.
        try {
          await access(DAEMON_SOCKET_PATH);
        } catch {
          return toToolResult(
            {
              success: false,
              error: {
                kind: "not_connected",
                message: "Browser harness not initialized. Run /browser-setup first",
              },
            },
            def.name,
          );
        }
        const alive = await client.ensureAlive();
        if (!alive.success) {
          return toToolResult(
            { success: false, error: { kind: "not_connected", message: alive.error.message } },
            def.name,
          );
        }
      }
      let release: (() => void) | undefined;
      if (def.concurrency !== "parallel") {
        const acquire = await client.mutationMutex().acquire();
        release = acquire;
        if (signal?.aborted) {
          release();
          return toToolResult(
            { success: false, error: { kind: "invalid_state", message: "Tool execution aborted before entering serialized lane" } },
            def.name,
          );
        }
      }
      try {
        const result = await def.handler(args, {
          client,
          signal,
          onUpdate: (u) => {
            if (onUpdate) {
              const update: AgentToolResult<OkDetails> = {
                content: [{ type: "text", text: u.text }],
                details: { ok: true, ...(u.details ?? {}) },
              };
              onUpdate(update);
            }
          },
          extensionCtx,
        });
        return toToolResult(result, def.name);
      } finally {
        release?.();
      }
    },
  };
  pi.registerTool(td);
};
