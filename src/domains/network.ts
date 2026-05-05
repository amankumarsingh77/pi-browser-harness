import { Type } from "typebox";
import { Markdown, Text } from "@mariozechner/pi-tui";
import { getMarkdownTheme, keyHint } from "@mariozechner/pi-coding-agent";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { applyTruncation } from "../util/truncate";
import type { NetworkRecord } from "../cdp/network-buffer";

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

const NetworkRequestsArgs = Type.Object({
  urlPattern: Type.Optional(
    Type.String({ description: "Substring match by default. Wrap in slashes (e.g. /api\\\\.example/) for regex." }),
  ),
  methodFilter: Type.Optional(
    Type.Array(Type.String(), { description: 'HTTP methods to include, e.g. ["GET","POST"].' }),
  ),
  statusFilter: Type.Optional(
    Type.Object(
      {
        min: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
        max: Type.Optional(Type.Integer({ minimum: 100, maximum: 599 })),
      },
      { description: "Inclusive HTTP status range." },
    ),
  ),
  resourceTypes: Type.Optional(
    Type.Array(Type.String(), { description: 'CDP resource types: "Document","Stylesheet","Image","Media","Font","Script","TextTrack","XHR","Fetch","EventSource","WebSocket","Manifest","SignedExchange","Ping","CSPViolationReport","Preflight","Other".' }),
  ),
  sinceMs: Type.Optional(
    Type.Integer({ minimum: 0, description: "Only requests started in the last N ms." }),
  ),
  limit: Type.Optional(
    Type.Integer({ default: 50, minimum: 1, maximum: 500, description: "Max records to return." }),
  ),
  includeResponseBodies: Type.Optional(
    Type.Boolean({ default: false, description: "Fetch response bodies via Network.getResponseBody. Costs one CDP call per matched request." }),
  ),
});

const BODY_BUDGET_MS = 5_000;
const PER_BODY_CAP = 50_000;

const renderNetworkMarkdown = (
  records: ReadonlyArray<NetworkRecord>,
  opts: { includeBodies: boolean; total: number; bufferOverflowed: boolean; expanded: boolean },
): string => {
  if (records.length === 0) {
    if (opts.bufferOverflowed) return "_No matching requests. (Buffer overflowed since last drain — some events were dropped.)_";
    return "_No matching requests captured yet._";
  }

  const failed = records.filter((r) => r.failed || (r.status !== undefined && r.status >= 500)).length;
  const totalBytes = records.reduce((s, r) => s + (r.responseBodySize ?? 0), 0);
  const formatBytes = (n: number): string => {
    if (n >= 1_048_576) return `${(n / 1_048_576).toFixed(1)} MB`;
    if (n >= 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${n} B`;
  };
  const showWindow = (() => {
    const finished = records.filter((r) => r.durationMs !== undefined);
    if (finished.length === 0) return "";
    const span = Math.max(...records.map((r) => r.requestStartedMs)) - Math.min(...records.map((r) => r.requestStartedMs));
    return ` · ${(span / 1000).toFixed(1)}s window`;
  })();

  const headerLines: string[] = [
    `**${records.length} requests** · ${failed} failed · ${formatBytes(totalBytes)}${showWindow}`,
  ];
  if (opts.bufferOverflowed) headerLines.push("⚠ buffer overflowed since last drain — older events dropped");
  if (opts.total > records.length) headerLines.push(`(${records.length} of ${opts.total} matches shown — increase \`limit\` for more)`);

  const compactRows = (records.length > 5 && !opts.expanded ? records.slice(0, 5) : records).map((r) => {
    const status = r.failed ? "ERR" : r.status !== undefined ? String(r.status) : "—";
    const warn = r.failed || (r.status !== undefined && r.status >= 500) ? " ⚠" : "";
    const ms = r.durationMs !== undefined ? `${r.durationMs} ms` : "—";
    const url = r.url.length > 60 ? r.url.slice(0, 57) + "…" : r.url;
    return `\`${r.method.padEnd(4)} ${status.padStart(3)}\`  ${url}  _${ms}_${warn}`;
  });

  const rows = compactRows.join("\n");

  if (!opts.expanded) {
    const more = records.length > 5 ? `\n  … ${records.length - 5} more` : "";
    return `${headerLines.join("\n")}\n\n${rows}${more}`;
  }

  // Expanded: full table + optional body sections.
  const tableHeader = `| # | Method | Status | URL | Type | ms |\n|---|---|---|---|---|---|`;
  const tableRows = records
    .map((r, i) => {
      const status = r.failed ? "ERR" : r.status !== undefined ? String(r.status) : "—";
      const ms = r.durationMs !== undefined ? String(r.durationMs) : "—";
      const url = r.url.length > 80 ? r.url.slice(0, 77) + "…" : r.url;
      return `| ${i + 1} | ${r.method} | ${status} | \`${url}\` | ${r.type} | ${ms} |`;
    })
    .join("\n");

  let bodySections = "";
  if (opts.includeBodies) {
    const sections: string[] = [];
    records.forEach((r, i) => {
      if (r.body === undefined) return;
      const sizes = `${r.requestBodySize} B → ${r.responseBodySize ?? 0} B`;
      const status = r.failed ? "failed" : r.status ?? "?";
      const header = `── #${i + 1} ${r.method} ${r.url} (${status}, ${r.durationMs ?? "?"} ms, ${r.type}, ${sizes}) ──`;
      const bodyText = r.body === null ? "_(body unavailable — already GC'd by Chrome)_" : "```\n" + r.body + "\n```";
      sections.push(`${header}\n\n${bodyText}`);
    });
    if (sections.length > 0) bodySections = "\n\n" + sections.join("\n\n");
  }

  return [headerLines.join("\n"), "", tableHeader, tableRows, bodySections].filter((s) => s !== "").join("\n");
};

type NetworkDetails = {
  total: number;
  returned: number;
  bufferOverflowed: boolean;
  truncated: boolean;
  fullOutputPath?: string;
  requests: ReadonlyArray<NetworkRecord>;
  includeBodies: boolean;
};

export const networkRequestsTool = defineBrowserTool({
  name: "browser_network_requests",
  label: "Browser Network Requests",
  description:
    "List recent network requests captured on the current tab since attach. Filter by URL pattern, method, status, resource type, or recency. Optionally include response bodies.",
  promptSnippet: "Inspect recent network requests on the current page",
  promptGuidelines: [
    "Buffer is reset on tab switch — only requests on the current tab since attach are visible.",
    'urlPattern is a substring; wrap in slashes for regex (e.g. "/\\\\.json$/").',
    "includeResponseBodies:true costs an extra CDP call per matched request — use only when you need payloads.",
    "If bufferOverflowed:true in the result, older events were dropped (capacity 500 records/tab).",
  ],
  parameters: NetworkRequestsArgs,

  async handler(args, { client }): Promise<Result<ToolOk, ToolErr>> {
    const session = client.session();
    const drained = session.drainNetworkBuffer({
      ...(args.urlPattern !== undefined ? { urlPattern: args.urlPattern } : {}),
      ...(args.methodFilter !== undefined ? { methodFilter: args.methodFilter } : {}),
      ...(args.statusFilter !== undefined ? { statusFilter: args.statusFilter } : {}),
      ...(args.resourceTypes !== undefined ? { resourceTypes: args.resourceTypes } : {}),
      ...(args.sinceMs !== undefined ? { sinceMs: args.sinceMs } : {}),
      limit: args.limit ?? 50,
    });

    if (args.includeResponseBodies) {
      const ac = new AbortController();
      const timer = setTimeout(() => ac.abort(), BODY_BUDGET_MS);
      const fills = drained.records.map(async (r) => {
        if (ac.signal.aborted) return;
        const bodyRes = await session.call("Network.getResponseBody", { requestId: r.requestId });
        if (!bodyRes.success) {
          r.body = null;
          return;
        }
        const b = bodyRes.data as { body: string; base64Encoded?: boolean };
        let body = b.base64Encoded ? Buffer.from(b.body, "base64").toString("utf8") : b.body;
        if (body.length > PER_BODY_CAP) body = body.slice(0, PER_BODY_CAP) + "…";
        r.body = body;
      });
      await Promise.allSettled(fills);
      clearTimeout(timer);
    }

    const text = renderNetworkMarkdown(drained.records, {
      includeBodies: args.includeResponseBodies ?? false,
      total: drained.total,
      bufferOverflowed: drained.bufferOverflowed,
      expanded: true, // full text always returned to the LLM; renderResult handles compact view for humans
    });
    const trunc = await applyTruncation(text, "network");

    const details: NetworkDetails = {
      total: drained.total,
      returned: drained.records.length,
      bufferOverflowed: drained.bufferOverflowed,
      truncated: trunc.wasTruncated,
      requests: drained.records,
      includeBodies: args.includeResponseBodies ?? false,
    };
    if (trunc.fullOutputPath !== undefined) details.fullOutputPath = trunc.fullOutputPath;

    return ok({ text: trunc.text, details });
  },

  renderResult(result, expanded, theme) {
    const details = result.details as NetworkDetails | undefined;
    if (!details) return new Text(theme.fg("error", "network: no details"), 0, 0);

    const md = renderNetworkMarkdown(details.requests, {
      includeBodies: details.includeBodies && expanded,
      total: details.total,
      bufferOverflowed: details.bufferOverflowed,
      expanded,
    });
    const tail = expanded
      ? `\n\n${keyHint("app.tools.expand", "to collapse")}${details.fullOutputPath ? ` · full payload at \`${details.fullOutputPath}\`` : ""}`
      : `\n\n${keyHint("app.tools.expand", "to expand")}`;

    return new Markdown(md + tail, 0, 0, getMarkdownTheme());
  },
});
