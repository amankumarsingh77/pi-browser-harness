import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient, handlerContext } from "./fake-client";
import { runOnElement } from "../../src/domains/element-call";
import { dispatchKeyTool } from "../../src/domains/keyboard";
import { readPageTool } from "../../src/domains/readpage/read-page";
import { executeJsTool } from "../../src/domains/js";
import { ok } from "../../src/util/result";
import { asRecord, asString } from "../../src/util/guards";

const RESOLVED_NODE = ok({ object: { type: "object", objectId: "obj-7" } });

describe("runOnElement by ref", () => {
  test("releases the resolved RemoteObject and awaits promises", async () => {
    const fake = await createFakeClient({
      refs: [{ ref: "e1", backendId: 101 }],
      canned: { "DOM.resolveNode": RESOLVED_NODE, "Runtime.callFunctionOn": ok({ result: { type: "number", value: 1 } }) },
    });
    const r = await runOnElement(fake.client, { ref: "e1", functionDeclaration: "function () { return 1; }", args: [] });
    assert.deepEqual(r, { success: true, data: { found: true, value: 1 } });
    const call = fake.callsTo("Runtime.callFunctionOn")[0];
    assert.equal(call?.params["awaitPromise"], true);
    const released = fake.callsTo("Runtime.releaseObject");
    assert.equal(released.length, 1);
    assert.equal(released[0]?.params["objectId"], "obj-7");
  });

  test("releases the object even when the page function throws", async () => {
    const fake = await createFakeClient({
      refs: [{ ref: "e1", backendId: 101 }],
      canned: {
        "DOM.resolveNode": RESOLVED_NODE,
        "Runtime.callFunctionOn": ok({ result: { type: "undefined" }, exceptionDetails: { text: "boom" } }),
      },
    });
    const r = await runOnElement(fake.client, { ref: "e1", functionDeclaration: "function () { throw 1; }", args: [] });
    assert.equal(r.success, false);
    assert.equal(fake.callsTo("Runtime.releaseObject").length, 1);
  });

  test("the selector path reports a missing element through the single found:false shape", async () => {
    const fake = await createFakeClient({ evaluate: () => ok({ found: false }) });
    const r = await runOnElement(fake.client, { selector: "#nope", functionDeclaration: "function () { return 1; }", args: [] });
    assert.deepEqual(r, { success: true, data: { found: false } });
  });

  test("neither ref nor selector is invalid_args", async () => {
    const fake = await createFakeClient();
    const r = await runOnElement(fake.client, { functionDeclaration: "function () { return 1; }", args: [] });
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
  });
});

describe("browser_dispatch_key by ref", () => {
  test("goes through the releasing path", async () => {
    const fake = await createFakeClient({
      refs: [{ ref: "e1", backendId: 101 }],
      canned: { "DOM.resolveNode": RESOLVED_NODE, "Runtime.callFunctionOn": ok({ result: { type: "number", value: 1 } }) },
    });
    const r = await dispatchKeyTool.handler({ ref: "e1", key: "Enter" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(fake.callsTo("Runtime.releaseObject").length, 1);
  });
});

describe("browser_read_page on an owned tab", () => {
  test("detaches from the target after reading, even when the read fails", async () => {
    const fake = await createFakeClient({
      canned: { "Target.getTargets": ok({ targetInfos: [
          { targetId: "t1", type: "page", title: "Fake", url: "https://example.test/" },
          { targetId: "t2", type: "page", title: "Other", url: "https://example.test/other" },
        ] }), "Target.attachToTarget": [ok({ sessionId: "s1" }), ok({ sessionId: "s-read" })] },
      evaluate: () => ({ success: false, error: { kind: "remote_error", message: "nope" } }),
      ownedTargetIds: ["t1", "t2"],
    });
    const r = await readPageTool.handler({ targetId: "t2" }, handlerContext(fake.client));
    assert.equal(r.success, false);
    const detached = fake.callsTo("Target.detachFromTarget");
    assert.equal(detached.length, 1);
    assert.equal(detached[0]?.params["sessionId"], "s-read");
  });

  test("neither url nor targetId is invalid_args", async () => {
    const fake = await createFakeClient();
    const r = await readPageTool.handler({}, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "invalid_args");
  });
});

describe("browser_execute_js details", () => {
  test("stores only a bounded preview, never the full value", async () => {
    const big = "x".repeat(50_000);
    const fake = await createFakeClient({ evaluate: () => ok({ big }) });
    const r = await executeJsTool.handler({ expression: "1" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    const details = asRecord(r.data.details);
    assert.ok(details);
    const preview = asString(details["preview"]) ?? "";
    assert.ok(preview.length < 200, `preview is ${preview.length} chars`);
    assert.equal(details["full"], undefined);
    assert.equal(details["pretty"], undefined);
    assert.equal(details["isJson"], true);
    assert.ok(r.data.text.includes(big.slice(0, 1000)), "the full value is in the text");
  });
});
