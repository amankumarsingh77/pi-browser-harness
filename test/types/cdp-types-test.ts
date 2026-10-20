// Type-level contract for the CDP command and event tables. The assertions below are checked by
// `npm run typecheck` (tsc -p tsconfig.test.json); a wrong shape or an accepted typo fails the build.
// The single runtime test exists so the node test runner has something to execute from this directory.

import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Value } from "typebox/value";
import { COMMANDS, type ParamsOf, type ResultOf } from "../../src/cdp/commands";
import { type EventParamsOf, decodeEvent } from "../../src/cdp/events";
import type { CdpSession } from "../../src/cdp/session";
import type { BrowserClient } from "../../src/client";
import { cdpCall, cdpCallBrowser } from "../../src/domains/cdp-call";

// Mutual assignability. Deliberately not the invariant `<T>() => T extends A` trick: TypeBox builds object types
// from mapped intersections, and this test cares that the shapes interoperate, not that they are spelled alike.
type Equal<A, B> = [A] extends [B] ? ([B] extends [A] ? true : false) : false;
type Expect<T extends true> = T;

// Exported so noUnusedLocals accepts a type that exists only to be checked.
export type CommandShapes = [
  Expect<Equal<ParamsOf<"Page.navigate">, { url: string; referrer?: string }>>,
  Expect<Equal<ResultOf<"Page.navigate">, { frameId: string; loaderId?: string; errorText?: string }>>,
  Expect<Equal<ResultOf<"Target.attachToTarget">, { sessionId: string }>>,
  Expect<Equal<keyof ParamsOf<"Page.enable">, never>>,
  Expect<Equal<ParamsOf<"Input.dispatchMouseEvent">["type"], "mousePressed" | "mouseReleased" | "mouseMoved" | "mouseWheel">>,
  Expect<Equal<NonNullable<ParamsOf<"Input.dispatchMouseEvent">["button"]>, "none" | "left" | "middle" | "right" | "back" | "forward">>,
  Expect<Equal<ParamsOf<"Input.dispatchKeyEvent">["type"], "keyDown" | "keyUp" | "rawKeyDown" | "char">>,
  Expect<Equal<ParamsOf<"Input.dispatchDragEvent">["type"], "dragEnter" | "dragOver" | "drop" | "dragCancel">>,
  Expect<Equal<ParamsOf<"Input.dispatchDragEvent">["data"]["items"][number], { mimeType: string; data: string; title?: string; baseURL?: string }>>,
  Expect<Equal<ParamsOf<"Browser.setDownloadBehavior">["behavior"], "deny" | "allow" | "allowAndName" | "default">>,
  Expect<Equal<NonNullable<ParamsOf<"Page.captureScreenshot">["format"]>, "jpeg" | "png" | "webp">>,
  Expect<Equal<ParamsOf<"Emulation.setDeviceMetricsOverride">["mobile"], boolean>>,
  Expect<Equal<ResultOf<"Page.printToPDF">["data"], string>>,
];

export type EventShapes = [
  Expect<Equal<EventParamsOf<"Page.javascriptDialogOpening">["message"], string>>,
  Expect<Equal<EventParamsOf<"Page.javascriptDialogOpening">["defaultPrompt"], string | undefined>>,
  Expect<Equal<EventParamsOf<"Network.requestWillBeSent">["request"]["url"], string>>,
  Expect<Equal<EventParamsOf<"Network.loadingFailed">["errorText"], string | undefined>>,
  Expect<Equal<EventParamsOf<"Target.targetDestroyed">["targetId"], string>>,
  Expect<Equal<EventParamsOf<"Target.targetCreated">["targetInfo"]["openerId"], string | undefined>>,
];

// Handlers written against the event table receive exactly the decoded shape.
export const onDialog = (p: EventParamsOf<"Page.javascriptDialogOpening">): string =>
  `${p.type}: ${p.message}${p.defaultPrompt === undefined ? "" : ` [${p.defaultPrompt}]`}`;

export const onDecodedDialog = (raw: unknown): string | undefined => {
  const decoded = decodeEvent("Page.javascriptDialogOpening", raw);
  return decoded.success ? onDialog(decoded.data) : undefined;
};

// Never called: it exists so tsc checks which call shapes compile. Each @ts-expect-error line must stay an error.
export const callSignatures = async (session: CdpSession, client: BrowserClient): Promise<ReadonlyArray<string>> => {
  // Methods with no required key may omit params, pass an empty object, or pass only opts after one.
  await session.call("Page.enable");
  await session.call("Page.enable", {});
  await session.call("Page.enable", {}, { timeoutMs: 1 });
  await session.call("Target.getTargetInfo");
  await session.callBrowser("Target.getTargets");
  await session.callBrowser("Target.getTargets", {}, { timeoutMs: 1 });
  await cdpCall(client, "Page.bringToFront");
  await cdpCallBrowser(client, "Target.getTargets");

  // Methods with a required key must receive params.
  await session.call("Page.navigate", { url: "about:blank" });
  await cdpCall(client, "Page.navigate", { url: "about:blank" }, { timeoutMs: 1 });
  // @ts-expect-error -- Page.navigate requires `url`
  await session.call("Page.navigate");
  // @ts-expect-error -- Page.navigate requires `url`
  await cdpCall(client, "Page.navigate");
  // @ts-expect-error -- Target.createTarget requires `url`
  await session.callBrowser("Target.createTarget");
  // @ts-expect-error -- `url` is required, an empty object is not enough
  await session.call("Page.navigate", {});
  // @ts-expect-error -- callOnTarget always takes params because the session id follows them
  await session.callOnTarget("Page.enable", "sid");

  // Typed Input params: a misspelled or unknown field is a compile error, not a silently ignored key.
  await session.call("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 2, button: "left", clickCount: 1 });
  // @ts-expect-error -- `clickcount` is not `clickCount`
  await session.call("Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 2, button: "left", clickcount: 1 });
  // @ts-expect-error -- `clickcount` is rejected through the tool-layer wrapper too
  await cdpCall(client, "Input.dispatchMouseEvent", { type: "mousePressed", x: 1, y: 2, clickcount: 1 });
  // @ts-expect-error -- `mouseDown` is not a CDP mouse event type
  await session.call("Input.dispatchMouseEvent", { type: "mouseDown", x: 1, y: 2 });
  // @ts-expect-error -- `x` and `y` are required
  await session.call("Input.dispatchMouseEvent", { type: "mouseMoved" });
  // @ts-expect-error -- `keydown` is not `keyDown`
  await session.call("Input.dispatchKeyEvent", { type: "keydown", key: "a" });
  // @ts-expect-error -- drag events need `data`
  await session.call("Input.dispatchDragEvent", { type: "drop", x: 1, y: 2 });
  // @ts-expect-error -- `behavior` is a literal union
  await session.callBrowser("Browser.setDownloadBehavior", { behavior: "yes" });
  // @ts-expect-error -- `format` is a literal union
  await session.call("Page.captureScreenshot", { format: "gif" });
  // @ts-expect-error -- exactOptionalPropertyTypes: an optional field is omitted, never passed as undefined
  await session.call("Page.captureScreenshot", { format: undefined });

  // Results are typed from the table.
  const nav = await session.call("Page.navigate", { url: "about:blank" });
  if (!nav.success) return [];
  const frameId: string = nav.data.frameId;
  // @ts-expect-error -- `loaderId` is optional
  const loaderId: string = nav.data.loaderId;
  return [frameId, loaderId];
};

describe("CDP command table at runtime", () => {
  test("the Input.dispatchMouseEvent schema rejects an unknown event type", () => {
    const schema = COMMANDS["Input.dispatchMouseEvent"].params;
    assert.equal(Value.Check(schema, { type: "mousePressed", x: 1, y: 2, button: "left", clickCount: 1 }), true);
    assert.equal(Value.Check(schema, { type: "mouseDown", x: 1, y: 2 }), false);
  });

  test("a decoded dialog event reaches its handler with the typed shape", () => {
    assert.equal(onDecodedDialog({ type: "prompt", message: "name?", defaultPrompt: "x" }), "prompt: name? [x]");
    assert.equal(onDecodedDialog({ type: "alert" }), undefined);
  });
});
