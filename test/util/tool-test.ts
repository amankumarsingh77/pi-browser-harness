// pi only marks a tool result as an error when execute rejects (pi-agent-core's agent loop
// hard-codes isError:false for any resolved result), so a failed handler has to throw.
// pi also persists `details` and replays them through renderResult in a later session, so the
// contract validates replayed details against the tool's schema before the renderer sees them.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Type, type TSchema } from "typebox";
import {
  type AgentToolResult,
  type ExtensionAPI,
  Theme,
  type ThemeColor,
  type ToolDefinition,
} from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { type BrowserToolDefinition, defineBrowserTool, renderToolError } from "../../src/util/tool";
import { err, ok } from "../../src/util/result";
import { isRecord } from "../../src/util/guards";
import { createFakeClient, handlerContext } from "../domains/fake-client";

const EMPTY = Type.Object({});
const ProbeDetails = Type.Object({ n: Type.Number(), label: Type.Optional(Type.String()) });

type ProbeDefinition<D extends TSchema> = Omit<
  BrowserToolDefinition<typeof EMPTY, D>,
  "name" | "label" | "description" | "promptSnippet" | "promptGuidelines" | "parameters" | "concurrency" | "ensureAlive"
>;

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const stripAnsi = (line: string): string => line.replace(ANSI_SEQUENCE, "").trimEnd();

const lines = (component: Component | undefined): string[] => {
  assert.ok(component, "renderer returned nothing");
  return component.render(80).map(stripAnsi);
};

const textComponent = (text: string): Component => ({
  render: () => [text],
  invalidate: () => {
    // Static text has nothing to invalidate.
  },
});

// Only the renderer's colour calls go through the theme, so any complete palette will do.
const FG_COLORS: Record<ThemeColor, number> = {
  accent: 7, border: 7, borderAccent: 7, borderMuted: 7, success: 7, error: 7, warning: 7, muted: 7, dim: 7, text: 7,
  thinkingText: 7, userMessageText: 7, customMessageText: 7, customMessageLabel: 7, toolTitle: 7, toolOutput: 7,
  mdHeading: 7, mdLink: 7, mdLinkUrl: 7, mdCode: 7, mdCodeBlock: 7, mdCodeBlockBorder: 7, mdQuote: 7, mdQuoteBorder: 7,
  mdHr: 7, mdListBullet: 7, toolDiffAdded: 7, toolDiffRemoved: 7, toolDiffContext: 7, syntaxComment: 7, syntaxKeyword: 7,
  syntaxFunction: 7, syntaxVariable: 7, syntaxString: 7, syntaxNumber: 7, syntaxType: 7, syntaxOperator: 7,
  syntaxPunctuation: 7, thinkingOff: 7, thinkingMinimal: 7, thinkingLow: 7, thinkingMedium: 7, thinkingHigh: 7,
  thinkingXhigh: 7, bashMode: 7,
};
const theme = new Theme(
  FG_COLORS,
  { selectedBg: 0, userMessageBg: 0, customMessageBg: 0, toolPendingBg: 0, toolSuccessBg: 0, toolErrorBg: 0 },
  "256color",
);

type RenderContext = Parameters<NonNullable<ToolDefinition["renderResult"]>>[3];
const renderContext = (isError: boolean): RenderContext => ({
  args: {},
  toolCallId: "id",
  state: undefined,
  cwd: process.cwd(),
  executionStarted: true,
  argsComplete: true,
  isPartial: false,
  expanded: false,
  showImages: false,
  isError,
  invalidate: () => {
    // Nothing is on screen in a test.
  },
  lastComponent: undefined,
});

// pi's registerTool erases the tool's own schema generics; the test only needs the two members it calls back.
type RegisteredTool = Pick<ToolDefinition, "execute" | "renderResult">;
const isRegisteredTool = (v: unknown): v is RegisteredTool => isRecord(v) && typeof v["execute"] === "function";

const register = async <D extends TSchema>(def: ProbeDefinition<D>): Promise<RegisteredTool> => {
  let registered: unknown;
  const pi: Pick<ExtensionAPI, "registerTool"> = {
    registerTool: (td) => {
      registered = td;
    },
  };
  const fake = await createFakeClient();
  defineBrowserTool({
    name: "browser_probe",
    label: "Probe",
    description: "probe",
    promptSnippet: "probe",
    promptGuidelines: [],
    parameters: EMPTY,
    concurrency: "parallel",
    ensureAlive: false,
    ...def,
  }).register(pi, fake.client);
  assert.ok(isRegisteredTool(registered), "tool was not registered");
  return registered;
};

const execute = async (td: RegisteredTool): Promise<AgentToolResult<unknown>> => {
  const fake = await createFakeClient();
  return td.execute("id", {}, undefined, undefined, handlerContext(fake.client).extensionCtx);
};

const replay = (td: RegisteredTool, stored: AgentToolResult<unknown>, isError = false): Component | undefined =>
  td.renderResult?.(stored, { expanded: false, isPartial: false }, theme, renderContext(isError));

describe("tool result mapping through pi's ToolDefinition.execute", () => {
  test("a successful handler resolves with its text and details stored verbatim", async () => {
    const td = await register({ handler: () => Promise.resolve(ok({ text: "done", details: { n: 1 } })) });
    const result = await execute(td);
    assert.deepEqual(result.content, [{ type: "text", text: "done" }]);
    assert.deepEqual(result.details, { n: 1 });
  });

  test("a failed handler rejects so pi marks the result as an error", async () => {
    const td = await register({ handler: () => Promise.resolve(err({ kind: "invalid_args", message: "ref is stale" })) });
    await assert.rejects(execute(td), { message: "browser_probe failed (invalid_args): ref is stale" });
  });

  test("a handler that throws is reported as an internal error, not a crash", async () => {
    const td = await register({ handler: () => Promise.reject(new Error("boom")) });
    await assert.rejects(execute(td), { message: renderToolError("browser_probe", { kind: "internal", message: "boom" }) });
  });

  test("a non-Error throw is stringified", async () => {
    // eslint-disable-next-line @typescript-eslint/prefer-promise-reject-errors -- the contract must cope with scripts that throw plain values
    const td = await register({ handler: () => Promise.reject("plain") });
    await assert.rejects(execute(td), { message: /internal\): plain/ });
  });
});

describe("typed details", () => {
  test("details declared by schema reach renderResult typed and intact", async () => {
    const td = await register({
      details: ProbeDetails,
      handler: () => Promise.resolve(ok({ text: "x", details: { n: 2, label: "two" } })),
      renderResult: (result) => textComponent(`n=${result.details.n} label=${result.details.label ?? "-"}`),
    });
    const stored = await execute(td);
    assert.deepEqual(stored.details, { n: 2, label: "two" });
    assert.deepEqual(lines(replay(td, stored)), ["n=2 label=two"]);
  });

  test("replayed details that no longer match the schema fall back to the stored text without reaching the renderer", async () => {
    let rendererCalls = 0;
    const td = await register({
      details: ProbeDetails,
      handler: () => Promise.resolve(ok({ text: "x", details: { n: 1 } })),
      renderResult: () => {
        rendererCalls++;
        return textComponent("typed");
      },
    });
    // An older session stored details under a previous shape.
    const stale: AgentToolResult<unknown> = { content: [{ type: "text", text: "3 nodes" }], details: { n: "one" } };
    assert.deepEqual(lines(replay(td, stale)), ["3 nodes"]);
    const missing: AgentToolResult<unknown> = { content: [{ type: "text", text: "3 nodes" }], details: undefined };
    assert.deepEqual(lines(replay(td, missing)), ["3 nodes"]);
    assert.equal(rendererCalls, 0);
  });

  test("a tool with no details schema still runs and renders with whatever it attached", async () => {
    const td = await register({
      handler: () => Promise.resolve(ok({ text: "plain" })),
      renderResult: (result) => textComponent(`details=${JSON.stringify(result.details)}`),
    });
    const stored = await execute(td);
    assert.deepEqual(stored.content, [{ type: "text", text: "plain" }]);
    assert.equal(stored.details, undefined);
    assert.deepEqual(lines(replay(td, stored)), ["details=undefined"]);
    const withObject: AgentToolResult<unknown> = { content: [{ type: "text", text: "plain" }], details: { any: 1 } };
    assert.deepEqual(lines(replay(td, withObject)), ['details={"any":1}']);
  });
});

describe("replayed error rendering", () => {
  const stored: AgentToolResult<unknown> = {
    content: [{ type: "text", text: "browser_probe failed (timeout): slow" }],
    details: {},
  };

  test("an error result bypasses the tool's own renderer and shows the thrown text", async () => {
    const td = await register({
      handler: () => Promise.resolve(ok({ text: "x" })),
      renderResult: () => textComponent("rendered ok"),
    });
    assert.deepEqual(lines(replay(td, stored, true)), ["browser_probe failed (timeout): slow"]);
  });

  test("a successful result still reaches the tool's own renderer", async () => {
    const td = await register({
      handler: () => Promise.resolve(ok({ text: "x" })),
      renderResult: () => textComponent("rendered ok"),
    });
    const okResult: AgentToolResult<unknown> = { content: [{ type: "text", text: "x" }], details: undefined };
    assert.deepEqual(lines(replay(td, okResult)), ["rendered ok"]);
  });
});
