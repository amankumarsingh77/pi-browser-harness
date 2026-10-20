import { Type } from "typebox";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { fromClient } from "./cdp-call";
import { safeJs } from "../util/js-template";
import { pollUntil, READY_STATE_COMPLETE, sleep } from "./poll";

export const pageInfoTool = defineBrowserTool({
  name: "browser_page_info",
  label: "Browser Page Info",
  description:
    "Get current page state: URL, title, viewport size, scroll position, page dimensions. If a JS dialog is open, returns dialog info instead.",
  promptSnippet: "Get current page URL, title, viewport, and scroll position",
  promptGuidelines: [
    "If browser_page_info returns a dialog, call browser_handle_dialog before any other browser actions: dialogs freeze the page's JS thread.",
  ],
  parameters: Type.Object({}),
  concurrency: "parallel",
  async handler(_args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = fromClient(await client.pageInfo(), "pageInfo");
    if (!r.success) return r;
    if ("dialog" in r.data) {
      const d = r.data.dialog;
      return ok({
        text: `⚠️  DIALOG OPEN: ${d.type}\nMessage: ${d.message}${d.defaultPrompt ? `\nDefault: ${d.defaultPrompt}` : ""}\n\nUse browser_handle_dialog to accept or dismiss.`,
        details: { dialog: d },
      });
    }
    const i = r.data;
    return ok({
      text: `URL: ${i.url}\nTitle: ${i.title}\nViewport: ${i.width}x${i.height}\nScroll: (${i.scrollX}, ${i.scrollY})\nPage size: ${i.pageWidth}x${i.pageHeight}`,
      details: { ...i },
    });
  },
});

const WaitArgs = Type.Object({
  seconds: Type.Number({ minimum: 0, maximum: 60, description: "Seconds to wait" }),
});

export const waitTool = defineBrowserTool({
  name: "browser_wait",
  label: "Browser Wait",
  description: "Wait N seconds before continuing.",
  promptSnippet: "Wait N seconds",
  promptGuidelines: ["Use sparingly — prefer browser_wait_for_load when waiting for a page load."],
  parameters: WaitArgs,
  concurrency: "parallel",
  async handler(args, { signal }): Promise<Result<ToolOk, ToolErr>> {
    await sleep(Math.round(args.seconds * 1000), signal);
    if (signal?.aborted) return err({ kind: "timeout", message: `Aborted before ${args.seconds}s elapsed` });
    return ok({ text: `Waited ${args.seconds}s` });
  },
});

const WaitForLoadArgs = Type.Object({
  timeout: Type.Optional(Type.Number({ default: 15, minimum: 1, maximum: 120, description: "Max seconds to wait. Default: 15." })),
});

export const waitForLoadTool = defineBrowserTool({
  name: "browser_wait_for_load",
  label: "Browser Wait For Load",
  description:
    "Poll until the current page reports document.readyState === 'complete'. Returns a typed timeout error if the deadline elapses.",
  promptSnippet: "Wait for the page to finish loading",
  promptGuidelines: [
    "Call after browser_navigate / browser_open_urls before extracting data.",
  ],
  parameters: WaitForLoadArgs,
  concurrency: "serialized",
  async handler(args, { client, signal }): Promise<Result<ToolOk, ToolErr>> {
    const timeoutMs = (args.timeout ?? 15) * 1000;
    const r = await pollUntil(client, READY_STATE_COMPLETE, { timeoutMs, signal, what: "page load" });
    if (!r.success) return r;
    const ms = r.data.elapsedMs;
    return ok({ text: `Page loaded in ${Math.round(ms / 100) / 10}s`, details: { ms } });
  },
});

const WaitForArgs = Type.Object({
  selector: Type.Optional(Type.String({ description: "CSS selector to wait for (or wait to disappear with gone:true)" })),
  text: Type.Optional(Type.String({ description: "Wait until this text appears anywhere in document.body" })),
  gone: Type.Optional(Type.Boolean({ default: false, description: "If true with a selector, wait until it is absent instead of present" })),
  timeout: Type.Optional(Type.Number({ default: 5, minimum: 1, maximum: 60, description: "Max seconds to wait. Default: 5." })),
});

export const waitForTool = defineBrowserTool({
  name: "browser_wait_for",
  label: "Browser Wait For",
  description:
    "Poll until a condition holds: a selector appears (or disappears with gone:true), or text appears in the page. Returns a typed timeout error if the deadline elapses. Use to wait for SPA content to render before interacting.",
  promptSnippet: "Wait for an element or text to appear (or an element to disappear)",
  promptGuidelines: [
    "Use before browser_fill / browser_click on dynamic pages so you act after the element renders.",
  ],
  parameters: WaitForArgs,
  concurrency: "parallel",
  async handler(args, { client, signal }): Promise<Result<ToolOk, ToolErr>> {
    if (args.selector === undefined && args.text === undefined) {
      return err({ kind: "invalid_args", message: "Provide a selector or text to wait for." });
    }
    const gone = args.gone ?? false;
    const timeoutMs = (args.timeout ?? 5) * 1000;
    const expr =
      args.selector !== undefined
        ? safeJs`(() => { const found = !!document.querySelector(${args.selector}); return ${gone} ? !found : found; })()`
        : safeJs`(() => { const t = document.body ? document.body.innerText : ""; return t.includes(${args.text}); })()`;
    const what = args.selector !== undefined ? `${args.selector}${gone ? " to disappear" : ""}` : `text "${args.text}"`;
    const r = await pollUntil(client, expr, { timeoutMs, signal, what });
    if (!r.success) return r;
    const ms = r.data.elapsedMs;
    const met = args.selector !== undefined ? `${args.selector}${gone ? " gone" : ""}` : `text "${args.text}"`;
    return ok({ text: `Condition met (${met}) in ${Math.round(ms / 100) / 10}s`, details: { ms } });
  },
});
