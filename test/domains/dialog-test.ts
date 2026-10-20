import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient, flush, handlerContext } from "./fake-client";
import { handleDialogTool } from "../../src/domains/dialog";

describe("browser_handle_dialog", () => {
  test("accept sends accept:true without a promptText key", async () => {
    const fake = await createFakeClient();
    const r = await handleDialogTool.handler({ accept: true }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Dialog accepted");
    assert.deepEqual(r.data.details, { accept: true });
    const calls = fake.callsTo("Page.handleJavaScriptDialog");
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0]?.params, { accept: true });
    assert.equal(calls[0].sessionId, "s1");
  });

  test("dismiss sends accept:false", async () => {
    const fake = await createFakeClient();
    const r = await handleDialogTool.handler({ accept: false }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.equal(r.data.text, "Dialog dismissed");
    assert.deepEqual(r.data.details, { accept: false });
    assert.deepEqual(fake.callsTo("Page.handleJavaScriptDialog")[0]?.params, { accept: false });
  });

  test("promptText is forwarded for prompt() dialogs", async () => {
    const fake = await createFakeClient();
    const r = await handleDialogTool.handler({ accept: true, promptText: "my answer" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    assert.deepEqual(fake.callsTo("Page.handleJavaScriptDialog")[0]?.params, { accept: true, promptText: "my answer" });
  });

  test("an empty promptText is still forwarded (it clears the default)", async () => {
    const fake = await createFakeClient();
    await handleDialogTool.handler({ accept: true, promptText: "" }, handlerContext(fake.client));
    assert.deepEqual(fake.callsTo("Page.handleJavaScriptDialog")[0]?.params, { accept: true, promptText: "" });
  });

  test("no open dialog surfaces Chrome's error as cdp_error naming the method", async () => {
    const fake = await createFakeClient({
      canned: {
        "Page.handleJavaScriptDialog": { success: false, error: { kind: "remote_error", message: "No dialog is showing" } },
      },
    });
    const r = await handleDialogTool.handler({ accept: true }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "cdp_error");
    assert.equal(r.error.message, "No dialog is showing");
    assert.deepEqual(r.error.details, { method: "Page.handleJavaScriptDialog" });
  });

  test("a CDP timeout keeps its timeout kind", async () => {
    const fake = await createFakeClient({
      canned: { "Page.handleJavaScriptDialog": { success: false, error: { kind: "timeout", message: "slow" } } },
    });
    const r = await handleDialogTool.handler({ accept: false }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.equal(r.error.kind, "timeout");
  });

  test("the session drops the recorded dialog once Chrome reports it closed", async () => {
    // The tool only talks to Chrome; Chrome's javascriptDialogClosed is what clears the record, so a
    // handled (or navigated-away) dialog is never reported as still open by the next browser_page_info.
    const fake = await createFakeClient();
    fake.emit({ method: "Page.javascriptDialogOpening", sessionId: "s1", params: { type: "prompt", message: "name?", defaultPrompt: "x" } });
    await flush();
    const r = await handleDialogTool.handler({ accept: true, promptText: "y" }, handlerContext(fake.client));
    assert.equal(r.success, true);
    fake.emit({ method: "Page.javascriptDialogClosed", sessionId: "s1", params: { result: true, userInput: "y" } });
    await flush();
    assert.equal(fake.client.takeDialog(), null);
  });

  test("a failed handle leaves the pending dialog in place", async () => {
    const fake = await createFakeClient({ canned: { "Page.handleJavaScriptDialog": { success: false, error: { kind: "remote_error", message: "No dialog is showing" } } } });
    fake.emit({ method: "Page.javascriptDialogOpening", sessionId: "s1", params: { type: "alert", message: "hi" } });
    await flush();
    const r = await handleDialogTool.handler({ accept: true }, handlerContext(fake.client));
    assert.equal(r.success, false);
    assert.deepEqual(fake.client.takeDialog(), { type: "alert", message: "hi" });
  });
});
