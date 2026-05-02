import { Type } from "typebox";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { applyTruncation } from "../util/truncate";

const HttpGetArgs = Type.Object({
  url: Type.String({ description: "URL to GET" }),
  headers: Type.Optional(Type.Record(Type.String(), Type.String(), { description: "Optional HTTP headers" })),
  timeout: Type.Optional(
    Type.Number({ default: 20, minimum: 1, maximum: 120, description: "Total seconds (covers headers AND body)" }),
  ),
});

export const httpGetTool = defineBrowserTool({
  name: "browser_http_get",
  label: "Browser HTTP GET",
  description:
    "Fetch a URL outside the browser (faster than browser_navigate for APIs and static pages). Timeout covers headers AND body read.",
  promptSnippet: "HTTP GET (outside browser; for APIs/static pages)",
  promptGuidelines: [
    "Faster than navigate+execute_js for JSON/HTML APIs.",
    "No JS rendering — for SPAs use browser_navigate.",
  ],
  parameters: HttpGetArgs,
  ensureAlive: false,
  async handler(args): Promise<Result<ToolOk, ToolErr>> {
    const ac = new AbortController();
    const timer = setTimeout(() => ac.abort(), (args.timeout ?? 20) * 1000);
    try {
      const fetchInit: RequestInit = { signal: ac.signal };
      if (args.headers !== undefined) fetchInit.headers = args.headers;
      const res = await fetch(args.url, fetchInit);
      const body = await res.text();
      clearTimeout(timer);
      const ct = res.headers.get("content-type") ?? "";
      const truncated = await applyTruncation(body, "http");
      return ok({
        text: `HTTP ${res.status} ${ct}\n${truncated.text}`,
        details: truncated.fullOutputPath !== undefined
          ? { status: res.status, contentType: ct, length: body.length, fullOutputPath: truncated.fullOutputPath, wasTruncated: truncated.wasTruncated }
          : { status: res.status, contentType: ct, length: body.length, wasTruncated: truncated.wasTruncated },
      });
    } catch (e) {
      clearTimeout(timer);
      const msg = e instanceof Error ? e.message : String(e);
      const kind: ToolErr["kind"] = msg.toLowerCase().includes("abort") ? "timeout" : "io_error";
      return err({ kind, message: msg });
    }
  },
});

const NetLogArgs = Type.Object({
  eventTypes: Type.Optional(
    Type.Array(Type.String(), { description: "CDP event names to filter (e.g., ['Network.requestWillBeSent'])" }),
  ),
  limit: Type.Optional(Type.Integer({ default: 50, minimum: 1, maximum: 500 })),
});

export const getNetworkLogTool = defineBrowserTool({
  name: "browser_get_network_log",
  label: "Browser Get Network Log",
  description:
    "Read buffered Network.* CDP events. NOTE: in v0.3 the event stream is consumed internally by the session manager; this tool is a placeholder. Use browser_execute_js with PerformanceObserver as a workaround.",
  promptSnippet: "Get buffered network events (DEPRECATED in v0.3 — see description)",
  promptGuidelines: [
    "v0.3 routes CDP events through an internal AsyncIterable; a synchronous drain API isn't exposed yet.",
    "For now, use browser_execute_js with PerformanceObserver, performance.getEntries(), or fetch interceptors.",
  ],
  parameters: NetLogArgs,
  async handler(args): Promise<Result<ToolOk, ToolErr>> {
    return ok({
      text: "browser_get_network_log: in v0.3 the CDP event stream is consumed by the session; use browser_execute_js with PerformanceObserver or performance.getEntries() to inspect network activity.",
      details: {
        deprecated: true,
        eventTypes: args.eventTypes ?? null,
        limit: args.limit ?? null,
      },
    });
  },
});
