import { Type } from "typebox";
import type { BrowserClient } from "../client";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { cdpCall } from "./cdp-call";

const HeaderValue = Type.String({
  maxLength: 8192,
  pattern: "^[^\\r\\n]*$",
});

const SetHeadersArgs = Type.Object({
  headers: Type.Record(Type.String(), HeaderValue, {
    minProperties: 1,
    maxProperties: 64,
    description: "Extra HTTP request headers for the current owned tab. Names must be valid HTTP tokens.",
  }),
});

const HEADER_NAME = /^[!#$%&'*+\-.^_`|~0-9A-Za-z]+$/;

const currentOwnedTarget = (
  client: BrowserClient,
): Result<{ readonly targetId: string }, ToolErr> => {
  const current = client.current();
  if (current === undefined || current === null) {
    return err({ kind: "invalid_state", message: "No tab attached." });
  }
  if (!client.owns(current.targetId)) {
    return err({
      kind: "invalid_state",
      message: `Current tab ${current.targetId} is not owned by this harness session.`,
    });
  }
  return ok({ targetId: current.targetId });
};

export const setHeadersTool = defineBrowserTool({
  name: "browser_set_headers",
  label: "Browser Set Headers",
  description:
    "Set extra HTTP request headers on the current owned tab. Headers persist for subsequent document, subresource, fetch, and XHR requests until cleared or the tab closes.",
  promptSnippet: "Set extra request headers on the current owned tab",
  promptGuidelines: [
    "If no tab is attached yet, call browser_new_tab without a URL first.",
    "Call before navigation when a site requires routing or environment headers.",
    "Call browser_clear_headers before switching tabs or navigating this tab to another origin.",
    "Header values are never echoed in tool output.",
  ],
  parameters: SetHeadersArgs,
  concurrency: "serialized",
  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const target = currentOwnedTarget(client);
    if (!target.success) return target;
    const invalidName = Object.keys(args.headers).find((name) => !HEADER_NAME.test(name));
    if (invalidName !== undefined) {
      return err({ kind: "invalid_state", message: `Invalid HTTP header name: ${JSON.stringify(invalidName)}` });
    }
    const result = await cdpCall(client, "Network.setExtraHTTPHeaders", { headers: args.headers });
    if (!result.success) return result;
    const headerNames = Object.keys(args.headers).sort();
    return ok({
      text: `Set ${headerNames.length} extra HTTP header(s) on tab ${target.data.targetId}: ${headerNames.join(", ")}. Values are hidden. Clear them before switching tabs or navigating to another origin.`,
      details: { targetId: target.data.targetId, headerNames, count: headerNames.length },
    });
  },
});

export const clearHeadersTool = defineBrowserTool({
  name: "browser_clear_headers",
  label: "Browser Clear Headers",
  description: "Clear all extra HTTP request headers previously set on the current owned tab.",
  promptSnippet: "Clear extra request headers from the current owned tab",
  promptGuidelines: [
    "Call after finishing an environment-specific workflow, before switching tabs, or before navigating to another origin.",
  ],
  parameters: Type.Object({}),
  concurrency: "serialized",
  async handler(_args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const target = currentOwnedTarget(client);
    if (!target.success) return target;
    const result = await cdpCall(client, "Network.setExtraHTTPHeaders", { headers: {} });
    if (!result.success) return result;
    return ok({
      text: `Cleared extra HTTP headers from tab ${target.data.targetId}.`,
      details: { targetId: target.data.targetId },
    });
  },
});
