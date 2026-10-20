import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { setImmediate as tick } from "node:timers/promises";
import { initTheme, Theme } from "@mariozechner/pi-coding-agent";
import type { Component } from "@mariozechner/pi-tui";
import { createFakeClient, type FakeClient, handlerContext } from "./fake-client";
import { type ConsoleDetails, consoleTool } from "../../src/domains/console";
import type { ConsoleRecord } from "../../src/cdp/console-buffer";

const ANSI_SEQUENCE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, "g");
const rendered = (component: Component): string =>
  component.render(400).map((l) => l.replace(ANSI_SEQUENCE, "").trimEnd()).join("\n");

before(() => { initTheme("dark"); });
const anyTheme = (): Theme => Theme.prototype;

const flush = async (): Promise<void> => {
  await tick();
  await tick();
};

type ConsoleType = "log" | "info" | "warning" | "error" | "debug";

// Emits a console.* call on the fake's page session; the session routes it into the current tab's buffer.
const consoleCall = (
  fake: FakeClient,
  type: ConsoleType,
  text: string,
  frame?: { url: string; lineNumber: number; functionName?: string },
): void => {
  fake.emit({
    method: "Runtime.consoleAPICalled",
    sessionId: "s1",
    params: {
      type,
      args: [{ type: "string", value: text }],
      ...(frame !== undefined ? { stackTrace: { callFrames: [frame] } } : {}),
    },
  });
};

const record = (seq: number, level: ConsoleRecord["level"], text: string, extra: Partial<ConsoleRecord> = {}): ConsoleRecord => ({
  seq, timestampMs: 1_000, level, text, source: "console-api", ...extra,
});

describe("browser_console drain", () => {
  test("returns the buffered records with a cursor and a summary header", async () => {
    const fake = await createFakeClient();
    consoleCall(fake, "log", "hello");
    consoleCall(fake, "error", "boom", { url: "https://x.test/app.js", lineNumber: 41, functionName: "run" });
    await flush();

    const r = await consoleTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    const details = r.data.details;
    assert.ok(details);
    assert.equal(details.total, 2);
    assert.equal(details.returned, 2);
    assert.equal(details.bufferOverflowed, false);
    assert.equal(details.truncated, false);
    assert.equal(details.fullOutputPath, undefined);
    assert.equal(details.nextCursor, 2);
    assert.deepEqual(details.records.map((x) => [x.seq, x.level, x.text]), [[1, "log", "hello"], [2, "error", "boom"]]);
    const errorRecord = details.records[1];
    assert.equal(errorRecord?.url, "https://x.test/app.js");
    assert.equal(errorRecord.lineNumber, 42);
    assert.equal(errorRecord.stackTrace, "  at run (https://x.test/app.js:42)");

    assert.match(r.data.text, /^\*\*1 error · 1 log\*\*\n\n/);
    assert.match(r.data.text, /`\[log\] {2}` hello\n/);
    assert.match(r.data.text, /`\[error\]` boom {2}_at https:\/\/x\.test\/app\.js:42_\n```\n {2}at run \(https:\/\/x\.test\/app\.js:42\)\n```/);
    assert.match(r.data.text, /_nextCursor=2_$/);
    assert.equal(fake.calls.length, 0, "the drain is local; no CDP call is made");
  });

  test("an empty buffer reports no records and no cursor", async () => {
    const fake = await createFakeClient();
    const r = await consoleTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "_No matching console records captured yet._");
    const details: ConsoleDetails = { total: 0, returned: 0, bufferOverflowed: false, truncated: false, records: [] };
    assert.deepEqual(r.data.details, details);
  });

  test("a drain does not remove records, and each drain hands out fresh copies", async () => {
    const fake = await createFakeClient();
    consoleCall(fake, "log", "once");
    await flush();
    const first = await consoleTool.handler({}, handlerContext(fake.client));
    const second = await consoleTool.handler({}, handlerContext(fake.client));
    assert.equal(first.success, true);
    assert.equal(second.success, true);
    assert.deepEqual(first.data.details?.records, second.data.details?.records);
    assert.notEqual(first.data.details?.records[0], second.data.details?.records[0], "records are copied out of the buffer");
  });

});

describe("browser_console filters", () => {
  const seeded = async (): Promise<FakeClient> => {
    const fake = await createFakeClient();
    consoleCall(fake, "log", "alpha one");
    consoleCall(fake, "warning", "beta two");
    consoleCall(fake, "error", "TypeError: gamma");
    consoleCall(fake, "info", "delta four");
    consoleCall(fake, "debug", "epsilon five");
    await flush();
    return fake;
  };

  test("levels keeps only the listed levels (warning maps to warn)", async () => {
    const fake = await seeded();
    const r = await consoleTool.handler({ levels: ["error", "warn"] }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(r.data.details?.records.map((x) => x.level), ["warn", "error"]);
    assert.equal(r.data.details.total, 2);
  });

  test("textPattern is a substring match by default", async () => {
    const fake = await seeded();
    const r = await consoleTool.handler({ textPattern: "ta " }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(r.data.details?.records.map((x) => x.text), ["beta two", "delta four"]);
  });

  test("textPattern wrapped in slashes is a regex", async () => {
    const fake = await seeded();
    const r = await consoleTool.handler({ textPattern: "/^(alpha|epsilon)/" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(r.data.details?.records.map((x) => x.seq), [1, 5]);
  });

  test("an invalid regex falls back to a literal substring match", async () => {
    const fake = await createFakeClient();
    consoleCall(fake, "log", "value /(/ here");
    consoleCall(fake, "log", "other");
    await flush();
    const r = await consoleTool.handler({ textPattern: "/(/" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(r.data.details?.records.map((x) => x.text), ["value /(/ here"]);
  });

  test("sinceSeq pages through only what arrived after the previous cursor", async () => {
    const fake = await seeded();
    const first = await consoleTool.handler({}, handlerContext(fake.client));
    assert.equal(first.success, true);
    const cursor = first.data.details?.nextCursor;
    assert.equal(cursor, 5);

    consoleCall(fake, "log", "zeta six");
    await flush();
    const next = await consoleTool.handler({ sinceSeq: cursor }, handlerContext(fake.client));
    assert.equal(next.success, true);
    assert.deepEqual(next.data.details?.records.map((x) => [x.seq, x.text]), [[6, "zeta six"]]);
    assert.equal(next.data.details.total, 1);
    assert.equal(next.data.details.nextCursor, 6);

    const nothing = await consoleTool.handler({ sinceSeq: 6 }, handlerContext(fake.client));
    assert.equal(nothing.success, true);
    assert.equal(nothing.data.details?.returned, 0);
    assert.equal(nothing.data.details.nextCursor, undefined);
  });

  test("sinceMs keeps records newer than the window", async () => {
    const fake = await seeded();
    const recent = await consoleTool.handler({ sinceMs: 60_000 }, handlerContext(fake.client));
    assert.equal(recent.success, true);
    assert.equal(recent.data.details?.total, 5);
  });

  test("limit returns the newest records and reports the full match count", async () => {
    const fake = await seeded();
    const r = await consoleTool.handler({ limit: 2 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(r.data.details?.records.map((x) => x.seq), [4, 5]);
    assert.equal(r.data.details.total, 5);
    assert.equal(r.data.details.returned, 2);
    assert.match(r.data.text, /\(2 of 5 matches shown — increase `limit` for more\)/);
  });

  test("filters combine", async () => {
    const fake = await seeded();
    const r = await consoleTool.handler({ levels: ["log", "debug"], textPattern: "five", limit: 10 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(r.data.details?.records.map((x) => x.text), ["epsilon five"]);
  });
});

describe("browser_console overflow", () => {
  test("overflow is reported once, on the first drain after records were dropped", async () => {
    const fake = await createFakeClient();
    for (let i = 0; i < 501; i++) consoleCall(fake, "log", `m${i}`);
    await flush();
    const r = await consoleTool.handler({ limit: 1 }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.details?.bufferOverflowed, true);
    assert.equal(r.data.details.total, 500);
    assert.equal(r.data.details.records[0]?.text, "m500");
    assert.match(r.data.text, /⚠ buffer overflowed since last drain/);

    const again = await consoleTool.handler({ limit: 1 }, handlerContext(fake.client));
    assert.equal(again.success, true);
    assert.equal(again.data.details?.bufferOverflowed, false);
  });

  test("an overflow with no match is reported in the empty message", async () => {
    const fake = await createFakeClient();
    for (let i = 0; i < 501; i++) consoleCall(fake, "log", `m${i}`);
    await flush();
    const r = await consoleTool.handler({ levels: ["error"] }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "_No matching console records. (Buffer overflowed since last drain — some events were dropped.)_");
  });
});

describe("browser_console ingests Log.entryAdded too", () => {
  test("a browser log entry becomes a log-entry record with its own location", async () => {
    const fake = await createFakeClient();
    fake.emit({
      method: "Log.entryAdded",
      sessionId: "s1",
      params: { entry: { level: "warning", text: "Mixed content", url: "https://x.test/", lineNumber: 0 } },
    });
    await flush();
    const r = await consoleTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, true);
    const rec = r.data.details?.records[0];
    assert.equal(rec?.source, "log-entry");
    assert.equal(rec.level, "warn");
    assert.equal(rec.url, "https://x.test/");
    assert.equal(rec.lineNumber, 1);
    assert.match(r.data.text, /`\[warn\] ` Mixed content {2}_at https:\/\/x\.test\/:1_/);
  });
});

describe("browser_console renderResult", () => {
  const details = (records: ReadonlyArray<ConsoleRecord>, extra: Partial<ConsoleDetails> = {}): ConsoleDetails => {
    const last = records[records.length - 1];
    return {
      total: records.length, returned: records.length, bufferOverflowed: false, truncated: false, records,
      ...(last !== undefined ? { nextCursor: last.seq } : {}),
      ...extra,
    };
  };
  const result = (d: ConsoleDetails) => ({ content: [{ type: "text" as const, text: "" }], details: d });
  const render = consoleTool.renderResult;

  const seven = Array.from({ length: 7 }, (_, i) => record(i + 1, i === 0 ? "error" : "log", `line ${i + 1}`, i === 0 ? { stackTrace: "  at f (x:1)" } : {}));

  test("collapsed shows the last five rows, the count of earlier ones and the expand hint", () => {
    assert.ok(render);
    const out = rendered(render(result(details(seven)), false, anyTheme()));
    assert.match(out, /1 error · 6 logs/);
    assert.doesNotMatch(out, /line 1\b/);
    assert.doesNotMatch(out, /line 2\b/);
    assert.match(out, /line 3/);
    assert.match(out, /line 7/);
    assert.match(out, /… 2 earlier \(expand to see all\)/);
    assert.match(out, /to expand/);
    assert.doesNotMatch(out, /at f \(x:1\)/, "stack traces are hidden when collapsed");
  });

  test("expanded shows every row with stack traces, the cursor and the collapse hint", () => {
    assert.ok(render);
    const out = rendered(render(result(details(seven, { fullOutputPath: "/tmp/console.txt" })), true, anyTheme()));
    assert.match(out, /line 1/);
    assert.match(out, /at f \(x:1\)/);
    assert.match(out, /nextCursor=7/);
    assert.match(out, /to collapse/);
    assert.match(out, /full payload at \/tmp\/console\.txt/);
  });

  test("collapsed rows are cut at 80 characters, expanded rows at 200", () => {
    assert.ok(render);
    const long = record(1, "log", "x".repeat(300));
    const collapsed = rendered(render(result(details([long])), false, anyTheme()));
    const expanded = rendered(render(result(details([long])), true, anyTheme()));
    assert.match(collapsed, /x{79}…/);
    assert.doesNotMatch(collapsed, /x{80}/);
    assert.match(expanded, /x{199}…/);
  });

  test("no records renders the empty message", () => {
    assert.ok(render);
    const out = rendered(render(result(details([])), false, anyTheme()));
    assert.match(out, /No matching console records captured yet/);
  });
});
