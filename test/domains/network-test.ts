import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { createFakeClient, type FakeClient, flush, handlerContext } from "./fake-client";
import { installTheme, renderedText, testTheme } from "./client-overrides";
import { httpGetTool, type NetworkDetails, networkRequestsTool } from "../../src/domains/network";
import type { NetworkRecord } from "../../src/cdp/network-buffer";
import { ok } from "../../src/util/result";


before(() => {
  installTheme();
});

type Sent = { id: string; url: string; method?: string; type?: string; postData?: string };

// Emits the request lifecycle on the fake's page session: sent, then (optionally) a response, then finished or failed.
const request = (fake: FakeClient, s: Sent, outcome?: { status?: number; mimeType?: string; size?: number; failed?: string; type?: string }): void => {
  fake.emit({
    method: "Network.requestWillBeSent",
    sessionId: "s1",
    params: {
      requestId: s.id,
      request: { url: s.url, method: s.method ?? "GET", ...(s.postData !== undefined ? { postData: s.postData } : {}) },
      type: s.type ?? "XHR",
    },
  });
  if (outcome === undefined) return;
  if (outcome.failed !== undefined) {
    fake.emit({ method: "Network.loadingFailed", sessionId: "s1", params: { requestId: s.id, errorText: outcome.failed } });
    return;
  }
  fake.emit({
    method: "Network.responseReceived",
    sessionId: "s1",
    params: {
      requestId: s.id,
      response: { status: outcome.status ?? 200, statusText: "OK", mimeType: outcome.mimeType ?? "application/json" },
      ...(outcome.type !== undefined ? { type: outcome.type } : {}),
    },
  });
  fake.emit({ method: "Network.loadingFinished", sessionId: "s1", params: { requestId: s.id, encodedDataLength: outcome.size ?? 10 } });
};

const seeded = async (): Promise<FakeClient> => {
  const fake = await createFakeClient();
  request(fake, { id: "r1", url: "https://api.test/users", method: "GET" }, { status: 200, size: 100 });
  request(fake, { id: "r2", url: "https://api.test/users", method: "post", postData: "abc", type: "Fetch" }, { status: 201, size: 5 });
  request(fake, { id: "r3", url: "https://cdn.test/app.js", type: "Script" }, { status: 500, size: 20 });
  request(fake, { id: "r4", url: "https://img.test/a.png", type: "Image" }, { failed: "net::ERR_FAILED" });
  request(fake, { id: "r5", url: "https://api.test/pending" });
  await flush();
  return fake;
};

const urls = (d: NetworkDetails | undefined): ReadonlyArray<string> => (d?.requests ?? []).map((r) => r.url);
const ids = (d: NetworkDetails | undefined): ReadonlyArray<string> => (d?.requests ?? []).map((r) => r.requestId);

describe("browser_network_requests drain", () => {
  test("returns the buffered requests with their lifecycle data and a summary header", async () => {
    const fake = await seeded();
    const r = await networkRequestsTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    const d = r.data.details;
    assert.ok(d);
    assert.equal(d.total, 5);
    assert.equal(d.returned, 5);
    assert.equal(d.bufferOverflowed, false);
    assert.equal(d.truncated, false);
    assert.equal(d.includeBodies, false);
    assert.equal(d.fullOutputPath, undefined);

    const [r1, r2, r3, r4, r5] = d.requests;
    assert.equal(r1?.status, 200);
    assert.equal(r1.statusText, "OK");
    assert.equal(r1.mimeType, "application/json");
    assert.equal(r1.responseBodySize, 100);
    assert.equal(typeof r1.durationMs, "number");
    assert.equal(r1.requestBodySize, 0);
    assert.equal(r2?.method, "post");
    assert.equal(r2.requestBodySize, 3);
    assert.equal(r2.type, "Fetch");
    assert.equal(r3?.status, 500);
    assert.equal(r4?.failed, true);
    assert.equal(r4.errorText, "net::ERR_FAILED");
    assert.equal(r4.status, undefined);
    assert.equal(r5?.durationMs, undefined);
    assert.ok(d.requests.every((x) => x.body === undefined), "no body is attached unless asked for");

    assert.match(r.data.text, /^\*\*5 requests\*\* · 2 failed · 125 B · \d+\.\ds window\n/);
    assert.match(r.data.text, /\| # \| Method \| Status \| URL \| Type \| ms \|/);
    assert.match(r.data.text, /\| 4 \| GET \| ERR \| `https:\/\/img\.test\/a\.png` \| Image \| \d+ \|/);
    assert.match(r.data.text, /\| 5 \| GET \| — \| `https:\/\/api\.test\/pending` \| XHR \| — \|/);
    assert.equal(fake.calls.length, 0, "the drain is local; no CDP call is made");
  });

  test("an empty buffer reports no requests", async () => {
    const fake = await createFakeClient();
    const r = await networkRequestsTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "_No matching requests captured yet._");
    const details: NetworkDetails = { total: 0, returned: 0, bufferOverflowed: false, truncated: false, requests: [], includeBodies: false };
    assert.deepEqual(r.data.details, details);
  });

  test("a drain does not remove records, and each drain hands out fresh copies", async () => {
    const fake = await seeded();
    const first = await networkRequestsTool.handler({}, handlerContext(fake.client));
    const second = await networkRequestsTool.handler({}, handlerContext(fake.client));
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.deepEqual(first.data.details?.requests, second.data.details?.requests);
    assert.notEqual(first.data.details?.requests[0], second.data.details?.requests[0]);
  });

  test("a re-sent request id (redirect) replaces the earlier record", async () => {
    const fake = await createFakeClient();
    request(fake, { id: "r1", url: "https://a.test/old" });
    request(fake, { id: "r1", url: "https://a.test/new" }, { status: 200 });
    await flush();
    const r = await networkRequestsTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(urls(r.data.details), ["https://a.test/new"]);
  });
});

describe("browser_network_requests filters", () => {
  test("urlPattern is a substring match by default and a regex in slashes", async () => {
    const fake = await seeded();
    const sub = await networkRequestsTool.handler({ urlPattern: "api.test" }, handlerContext(fake.client));
    assert.equal(sub.success, true);
    assert.deepEqual(ids(sub.data.details), ["r1", "r2", "r5"]);
    const re = await networkRequestsTool.handler({ urlPattern: "/\\.(js|png)$/" }, handlerContext(fake.client));
    assert.equal(re.success, true);
    assert.deepEqual(ids(re.data.details), ["r3", "r4"]);
  });

  test("methodFilter is case-insensitive", async () => {
    const fake = await seeded();
    const r = await networkRequestsTool.handler({ methodFilter: ["POST"] }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(ids(r.data.details), ["r2"]);
  });

  test("statusFilter is an inclusive range that excludes requests without a status", async () => {
    const fake = await seeded();
    const okOnly = await networkRequestsTool.handler({ statusFilter: { min: 200, max: 299 } }, handlerContext(fake.client));
    assert.equal(okOnly.success, true);
    assert.deepEqual(ids(okOnly.data.details), ["r1", "r2"]);
    const errors = await networkRequestsTool.handler({ statusFilter: { min: 500 } }, handlerContext(fake.client));
    assert.equal(errors.success, true);
    assert.deepEqual(ids(errors.data.details), ["r3"]);
  });

  test("resourceTypes is case-insensitive", async () => {
    const fake = await seeded();
    const r = await networkRequestsTool.handler({ resourceTypes: ["script", "IMAGE"] }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(ids(r.data.details), ["r3", "r4"]);
  });

  test("sinceMs keeps requests started inside the window", async () => {
    const fake = await seeded();
    const r = await networkRequestsTool.handler({ sinceMs: 60_000 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.details?.total, 5);
  });

  test("limit returns the newest records and reports the full match count", async () => {
    const fake = await seeded();
    const r = await networkRequestsTool.handler({ limit: 2 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(ids(r.data.details), ["r4", "r5"]);
    assert.equal(r.data.details?.total, 5);
    assert.equal(r.data.details.returned, 2);
    assert.match(r.data.text, /\(2 of 5 matches shown — increase `limit` for more\)/);
  });

  test("filters combine", async () => {
    const fake = await seeded();
    const r = await networkRequestsTool.handler({ urlPattern: "api.test", methodFilter: ["get"], statusFilter: { max: 299 } }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(ids(r.data.details), ["r1"]);
  });

  test("overflow is reported once, on the first drain after records were dropped", async () => {
    const fake = await createFakeClient();
    for (let i = 0; i < 501; i++) request(fake, { id: `q${i}`, url: `https://x.test/${i}` });
    await flush();
    const r = await networkRequestsTool.handler({ limit: 1 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.details?.bufferOverflowed, true);
    assert.equal(r.data.details.total, 500);
    assert.match(r.data.text, /⚠ buffer overflowed since last drain/);
    const again = await networkRequestsTool.handler({ limit: 1 }, handlerContext(fake.client));
    assert.equal(again.success, true);
    assert.equal(again.data.details?.bufferOverflowed, false);
  });
});

describe("browser_network_requests response bodies", () => {
  test("fetches each matched request's body, decoding base64, and renders it in the text", async () => {
    const fake = await createFakeClient({
      canned: { "Network.getResponseBody": ok({ body: Buffer.from('{"ok":true}').toString("base64"), base64Encoded: true }) },
    });
    request(fake, { id: "r1", url: "https://api.test/one" }, { status: 200 });
    await flush();
    const r = await networkRequestsTool.handler({ includeResponseBodies: true }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.details?.includeBodies, true);
    assert.equal(r.data.details.requests[0]?.body, '{"ok":true}');
    assert.deepEqual(fake.callsTo("Network.getResponseBody").map((c) => c.params), [{ requestId: "r1" }]);
    assert.match(r.data.text, /── #1 GET https:\/\/api\.test\/one \(200, \d+ ms, XHR, 0 B → 10 B\) ──\n\n```\n\{"ok":true\}\n```/);
  });

  test("a body Chrome no longer has is null and rendered as unavailable", async () => {
    const fake = await createFakeClient({
      canned: { "Network.getResponseBody": { success: false, error: { kind: "remote_error", message: "No resource with given identifier" } } },
    });
    request(fake, { id: "r1", url: "https://api.test/gone" }, { status: 200 });
    await flush();
    const r = await networkRequestsTool.handler({ includeResponseBodies: true }, handlerContext(fake.client));
    assert.equal(r.success, true, "a missing body does not fail the listing");
    assert.equal(r.data.details?.requests[0]?.body, null);
    assert.match(r.data.text, /_\(body unavailable — already GC'd by Chrome\)_/);
  });

  test("a body is capped at 50 000 characters", async () => {
    const fake = await createFakeClient({ canned: { "Network.getResponseBody": ok({ body: "z".repeat(60_000) }) } });
    request(fake, { id: "r1", url: "https://api.test/big" }, { status: 200 });
    await flush();
    const r = await networkRequestsTool.handler({ includeResponseBodies: true }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.details?.requests[0]?.body?.length, 50_001);
    assert.ok(r.data.details.requests[0].body.endsWith("…"));
  });

  test("bodies are attached to the returned copies, never to the buffer", async () => {
    const fake = await createFakeClient({ canned: { "Network.getResponseBody": ok({ body: "hello" }) } });
    request(fake, { id: "r1", url: "https://api.test/one" }, { status: 200 });
    await flush();
    const withBody = await networkRequestsTool.handler({ includeResponseBodies: true }, handlerContext(fake.client));
    assert.equal(withBody.success, true);
    assert.equal(withBody.data.details?.requests[0]?.body, "hello");
    const plain = await networkRequestsTool.handler({}, handlerContext(fake.client));
    assert.equal(plain.success, true);
    assert.equal(plain.data.details?.requests[0]?.body, undefined);
    assert.equal(fake.callsTo("Network.getResponseBody").length, 1);
  });

  test("an already-aborted signal skips every body fetch", async () => {
    const fake = await createFakeClient({ canned: { "Network.getResponseBody": ok({ body: "hello" }) } });
    request(fake, { id: "r1", url: "https://api.test/one" }, { status: 200 });
    await flush();
    const ac = new AbortController();
    ac.abort();
    const r = await networkRequestsTool.handler({ includeResponseBodies: true }, handlerContext(fake.client, ac.signal));
    assert.equal(r.success, true);
    assert.equal(r.data.details?.requests[0]?.body, undefined);
    assert.equal(fake.callsTo("Network.getResponseBody").length, 0);
  });
});

describe("browser_network_requests renderResult", () => {
  const rec = (i: number, extra: Partial<NetworkRecord> = {}): NetworkRecord => ({
    requestId: `r${i}`, method: "GET", url: `https://x.test/${i}`, type: "XHR", requestStartedMs: 1_000 + i, requestBodySize: 0,
    status: 200, durationMs: 5, responseBodySize: 10, ...extra,
  });
  const failedRec = (i: number): NetworkRecord => ({
    requestId: `r${i}`, method: "GET", url: `https://x.test/${i}`, type: "XHR", requestStartedMs: 1_000 + i, requestBodySize: 0,
    durationMs: 5, responseBodySize: 10, failed: true,
  });
  const details = (requests: ReadonlyArray<NetworkRecord>, extra: Partial<NetworkDetails> = {}): NetworkDetails => ({
    total: requests.length, returned: requests.length, bufferOverflowed: false, truncated: false, requests, includeBodies: false, ...extra,
  });
  const result = (d: NetworkDetails) => ({ content: [{ type: "text" as const, text: "" }], details: d });
  const render = networkRequestsTool.renderResult;

  test("collapsed shows the first five compact rows and how many more there are", () => {
    assert.ok(render);
    const seven = Array.from({ length: 7 }, (_, i) => rec(i + 1));
    const out = renderedText(render(result(details(seven)), false, testTheme), 160);
    assert.match(out, /7 requests · 0 failed · 70 B/);
    assert.match(out, /GET {2}200 {2}https:\/\/x\.test\/1 {2}5 ms/);
    assert.match(out, /https:\/\/x\.test\/5/);
    assert.doesNotMatch(out, /https:\/\/x\.test\/6/);
    assert.match(out, /… 2 more/);
    assert.match(out, /to expand/);
    assert.doesNotMatch(out, /\| # \| Method/);
  });

  test("a failure or 5xx is marked with a warning in the compact row", () => {
    assert.ok(render);
    const out = renderedText(render(result(details([failedRec(1), rec(2, { status: 503 })])), false, testTheme), 160);
    assert.match(out, /2 requests · 2 failed/);
    assert.match(out, /GET {2}ERR {2}https:\/\/x\.test\/1 {2}5 ms ⚠/);
    assert.match(out, /GET {2}503 {2}https:\/\/x\.test\/2 {2}5 ms ⚠/);
  });

  test("expanded renders the full table, and bodies only when they were captured", () => {
    assert.ok(render);
    const withBody = details([rec(1, { body: "payload-text" })], { includeBodies: true, fullOutputPath: "/tmp/net.txt" });
    const expanded = renderedText(render(result(withBody), true, testTheme), 160);
    assert.match(expanded, /│ # │ Method │ Status │ URL\s+│ Type │ ms │/);
    assert.match(expanded, /│ 1 │ GET\s+│ 200\s+│ https:\/\/x\.test\/1 │ XHR\s+│ 5\s+│/);
    assert.match(expanded, /payload-text/);
    assert.match(expanded, /full payload at \/tmp\/net\.txt/);
    assert.match(expanded, /to collapse/);

    const collapsed = renderedText(render(result(withBody), false, testTheme), 160);
    assert.doesNotMatch(collapsed, /payload-text/, "bodies are hidden when collapsed");

    const noBodies = renderedText(render(result(details([rec(1, { body: "payload-text" })])), true, testTheme), 160);
    assert.doesNotMatch(noBodies, /payload-text/, "bodies are shown only when the drain included them");
  });

  test("no records renders the empty message", () => {
    assert.ok(render);
    const out = renderedText(render(result(details([], { bufferOverflowed: true })), true, testTheme), 160);
    assert.match(out, /No matching requests\. \(Buffer overflowed since last drain/);
  });
});

describe("browser_http_get", () => {
  let server: Server;
  let base = "";
  const hanging = new Set<() => void>();

  before(async () => {
    server = createServer((req, res) => {
      if (req.url === "/hang") {
        hanging.add(() => { res.end(); });
        return;
      }
      if (req.url === "/echo-headers") {
        res.setHeader("content-type", "application/json");
        res.end(JSON.stringify({ seen: req.headers["x-probe"] ?? null }));
        return;
      }
      res.statusCode = 404;
      res.setHeader("content-type", "text/plain; charset=utf-8");
      res.end("nothing here");
    });
    await new Promise<void>((resolve) => { server.listen(0, "127.0.0.1", resolve); });
    const addr = server.address();
    assert.ok(addr && typeof addr !== "string");
    base = `http://127.0.0.1:${String((addr satisfies AddressInfo).port)}`;
  });

  after(async () => {
    for (const end of hanging) end();
    await new Promise<void>((resolve) => { server.close(() => { resolve(); }); });
  });

  test("returns the status, content type and body, and does not need the browser", async () => {
    assert.equal(httpGetTool.ensureAlive, false);
    const fake = await createFakeClient();
    const r = await httpGetTool.handler({ url: `${base}/missing` }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "HTTP 404 text/plain; charset=utf-8\nnothing here");
    assert.deepEqual(r.data.details, { status: 404, contentType: "text/plain; charset=utf-8", length: 12, wasTruncated: false });
    assert.equal(fake.calls.length, 0);
  });

  test("request headers are forwarded", async () => {
    const fake = await createFakeClient();
    const r = await httpGetTool.handler({ url: `${base}/echo-headers`, headers: { "x-probe": "yes" } }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, 'HTTP 200 application/json\n{"seen":"yes"}');
  });

  test("a server that never answers is a timeout", async () => {
    const fake = await createFakeClient();
    const r = await httpGetTool.handler({ url: `${base}/hang`, timeout: 1 }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
  });

  test("a connection failure is an io_error", async () => {
    const fake = await createFakeClient();
    const r = await httpGetTool.handler({ url: "http://127.0.0.1:1/" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "io_error");
  });
});
