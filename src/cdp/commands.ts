// The typed CDP command table — the extension point for everything the harness sends to Chrome.
//
// To add a command:
//   1. Look the method up in the Chrome DevTools Protocol viewer (https://chromedevtools.github.io/devtools-protocol/).
//   2. Add a `"Domain.method": cmd(ParamsSchema, ResultSchema)` entry below, in its domain's block.
//      - Mark optional protocol fields with `Type.Optional(...)` — never with `Type.Union([..., Type.Undefined()])`:
//        the project compiles with exactOptionalPropertyTypes, so callers must omit a field rather than pass undefined.
//      - Use `Type.Union([Type.Literal(...), ...])` for enumerated strings so a typo fails to compile.
//      - Result schemas are `additionalProperties: true` where Chrome may add fields; param schemas are closed.
//   3. `ParamsOf<"Domain.method">` / `ResultOf<"Domain.method">` now exist, and `session.call("Domain.method", ...)`
//      requires params exactly when the schema has a required key (see `CallArgs` in session.ts).
//   4. Results are validated at runtime by `decodeResult`; a payload that does not match is an `invalid_response` error.
// Events live in ./events.ts and follow the same pattern.

import { Type, type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { type Result, err, ok } from "../util/result";
import { type CdpError, cdpError } from "./errors";

const cmd = <P extends TSchema, R extends TSchema>(params: P, result: R) => ({
  params,
  result,
  validate: Compile(result),
});

const Empty = Type.Object({});

const TargetInfo = Type.Object(
  {
    targetId: Type.String(),
    type: Type.String(),
    title: Type.String(),
    url: Type.String(),
    attached: Type.Optional(Type.Boolean()),
    openerId: Type.Optional(Type.String()),
    browserContextId: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const RemoteObject = Type.Object(
  {
    type: Type.String(),
    subtype: Type.Optional(Type.String()),
    className: Type.Optional(Type.String()),
    value: Type.Optional(Type.Unknown()),
    description: Type.Optional(Type.String()),
    objectId: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const CallArgument = Type.Object(
  {
    value: Type.Optional(Type.Unknown()),
    objectId: Type.Optional(Type.String()),
    unserializableValue: Type.Optional(Type.String()),
  },
  { additionalProperties: true },
);

const ExceptionDetails = Type.Object(
  { text: Type.String(), exception: Type.Optional(RemoteObject) },
  { additionalProperties: true },
);

const AxValue = Type.Object({ value: Type.Optional(Type.Unknown()) }, { additionalProperties: true });

const AxNode = Type.Object(
  {
    nodeId: Type.String(),
    parentId: Type.Optional(Type.String()),
    childIds: Type.Optional(Type.Array(Type.String())),
    ignored: Type.Optional(Type.Boolean()),
    role: Type.Optional(AxValue),
    name: Type.Optional(AxValue),
    value: Type.Optional(AxValue),
    description: Type.Optional(AxValue),
    properties: Type.Optional(
      Type.Array(
        Type.Object(
          { name: Type.Optional(Type.String()), value: Type.Optional(AxValue) },
          { additionalProperties: true },
        ),
      ),
    ),
    backendDOMNodeId: Type.Optional(Type.Number()),
  },
  { additionalProperties: true },
);

export type AxNodeResult = Static<typeof AxNode>;

// Page.Viewport: a clip rectangle in CSS pixels.
const Viewport = Type.Object({
  x: Type.Number(),
  y: Type.Number(),
  width: Type.Number(),
  height: Type.Number(),
  scale: Type.Number(),
});

// Browser.setDownloadBehavior — "allowAndName" saves under the download's GUID; "default" restores Chrome's own policy.
const DownloadBehavior = Type.Union([
  Type.Literal("deny"),
  Type.Literal("allow"),
  Type.Literal("allowAndName"),
  Type.Literal("default"),
]);

const ScreenshotFormat = Type.Union([Type.Literal("jpeg"), Type.Literal("png"), Type.Literal("webp")]);

// Input.MouseButton
const MouseButton = Type.Union([
  Type.Literal("none"),
  Type.Literal("left"),
  Type.Literal("middle"),
  Type.Literal("right"),
  Type.Literal("back"),
  Type.Literal("forward"),
]);

const MouseEventType = Type.Union([
  Type.Literal("mousePressed"),
  Type.Literal("mouseReleased"),
  Type.Literal("mouseMoved"),
  Type.Literal("mouseWheel"),
]);

const KeyEventType = Type.Union([
  Type.Literal("keyDown"),
  Type.Literal("keyUp"),
  Type.Literal("rawKeyDown"),
  Type.Literal("char"),
]);

const DragEventType = Type.Union([
  Type.Literal("dragEnter"),
  Type.Literal("dragOver"),
  Type.Literal("drop"),
  Type.Literal("dragCancel"),
]);

// Input.DragDataItem / Input.DragData. `data` is the payload as a string (binary payloads are base64).
const DragDataItem = Type.Object({
  mimeType: Type.String(),
  data: Type.String(),
  title: Type.Optional(Type.String()),
  baseURL: Type.Optional(Type.String()),
});

const DragData = Type.Object({
  items: Type.Array(DragDataItem),
  files: Type.Optional(Type.Array(Type.String())),
  // Bit field of allowed operations: 1=Copy, 2=Link, 16=Move.
  dragOperationsMask: Type.Integer(),
});

// Emulation.ScreenOrientation
const ScreenOrientation = Type.Object({
  type: Type.Union([
    Type.Literal("portraitPrimary"),
    Type.Literal("portraitSecondary"),
    Type.Literal("landscapePrimary"),
    Type.Literal("landscapeSecondary"),
  ]),
  angle: Type.Integer(),
});

export const COMMANDS = {
  "Target.attachToTarget": cmd(
    Type.Object({ targetId: Type.String(), flatten: Type.Optional(Type.Boolean()) }),
    Type.Object({ sessionId: Type.String() }),
  ),
  "Target.detachFromTarget": cmd(
    Type.Object({ sessionId: Type.Optional(Type.String()) }),
    Empty,
  ),
  "Target.createTarget": cmd(
    Type.Object({
      url: Type.String(),
      newWindow: Type.Optional(Type.Boolean()),
      background: Type.Optional(Type.Boolean()),
      windowId: Type.Optional(Type.Number()),
      openerId: Type.Optional(Type.String()),
    }),
    Type.Object({ targetId: Type.String() }),
  ),
  "Target.closeTarget": cmd(
    Type.Object({ targetId: Type.String() }),
    Type.Object({ success: Type.Optional(Type.Boolean()) }),
  ),
  "Target.activateTarget": cmd(Type.Object({ targetId: Type.String() }), Empty),
  "Target.getTargetInfo": cmd(
    Type.Object({ targetId: Type.Optional(Type.String()) }),
    Type.Object({ targetInfo: TargetInfo }),
  ),
  "Target.getTargets": cmd(
    Type.Object({}),
    Type.Object({ targetInfos: Type.Array(TargetInfo) }),
  ),
  "Target.setDiscoverTargets": cmd(Type.Object({ discover: Type.Boolean() }), Empty),

  "Browser.getWindowForTarget": cmd(
    Type.Object({ targetId: Type.Optional(Type.String()) }),
    Type.Object({ windowId: Type.Number(), bounds: Type.Optional(Type.Unknown()) }),
  ),
  "Browser.setDownloadBehavior": cmd(
    Type.Object({
      behavior: DownloadBehavior,
      browserContextId: Type.Optional(Type.String()),
      downloadPath: Type.Optional(Type.String()),
      eventsEnabled: Type.Optional(Type.Boolean()),
    }),
    Empty,
  ),

  "Page.enable": cmd(Type.Object({}), Empty),
  "Page.bringToFront": cmd(Type.Object({}), Empty),
  "Page.navigate": cmd(
    Type.Object({ url: Type.String(), referrer: Type.Optional(Type.String()) }),
    Type.Object({
      frameId: Type.String(),
      loaderId: Type.Optional(Type.String()),
      errorText: Type.Optional(Type.String()),
    }),
  ),
  "Page.reload": cmd(Type.Object({ ignoreCache: Type.Optional(Type.Boolean()) }), Empty),
  "Page.getNavigationHistory": cmd(
    Type.Object({}),
    Type.Object({
      currentIndex: Type.Number(),
      entries: Type.Array(
        Type.Object({ id: Type.Number(), url: Type.String(), title: Type.String() }),
      ),
    }),
  ),
  "Page.navigateToHistoryEntry": cmd(Type.Object({ entryId: Type.Number() }), Empty),
  "Page.captureScreenshot": cmd(
    Type.Object({
      format: Type.Optional(ScreenshotFormat),
      // 0–100, jpeg and webp only.
      quality: Type.Optional(Type.Integer()),
      clip: Type.Optional(Viewport),
      fromSurface: Type.Optional(Type.Boolean()),
      captureBeyondViewport: Type.Optional(Type.Boolean()),
      optimizeForSpeed: Type.Optional(Type.Boolean()),
    }),
    Type.Object({ data: Type.String() }),
  ),
  "Page.printToPDF": cmd(
    Type.Object({
      landscape: Type.Optional(Type.Boolean()),
      displayHeaderFooter: Type.Optional(Type.Boolean()),
      printBackground: Type.Optional(Type.Boolean()),
      scale: Type.Optional(Type.Number()),
      // Paper size and margins are in inches.
      paperWidth: Type.Optional(Type.Number()),
      paperHeight: Type.Optional(Type.Number()),
      marginTop: Type.Optional(Type.Number()),
      marginBottom: Type.Optional(Type.Number()),
      marginLeft: Type.Optional(Type.Number()),
      marginRight: Type.Optional(Type.Number()),
      pageRanges: Type.Optional(Type.String()),
      headerTemplate: Type.Optional(Type.String()),
      footerTemplate: Type.Optional(Type.String()),
      preferCSSPageSize: Type.Optional(Type.Boolean()),
      transferMode: Type.Optional(Type.Union([Type.Literal("ReturnAsBase64"), Type.Literal("ReturnAsStream")])),
      generateTaggedPDF: Type.Optional(Type.Boolean()),
      generateDocumentOutline: Type.Optional(Type.Boolean()),
    }),
    Type.Object({ data: Type.String(), stream: Type.Optional(Type.String()) }),
  ),
  "Page.handleJavaScriptDialog": cmd(
    Type.Object({ accept: Type.Boolean(), promptText: Type.Optional(Type.String()) }),
    Empty,
  ),

  "Runtime.evaluate": cmd(
    Type.Object(
      {
        expression: Type.String(),
        returnByValue: Type.Optional(Type.Boolean()),
        awaitPromise: Type.Optional(Type.Boolean()),
        userGesture: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: true },
    ),
    Type.Object({ result: RemoteObject, exceptionDetails: Type.Optional(ExceptionDetails) }),
  ),
  "Runtime.callFunctionOn": cmd(
    Type.Object(
      {
        functionDeclaration: Type.String(),
        objectId: Type.Optional(Type.String()),
        arguments: Type.Optional(Type.Array(CallArgument)),
        returnByValue: Type.Optional(Type.Boolean()),
        awaitPromise: Type.Optional(Type.Boolean()),
        userGesture: Type.Optional(Type.Boolean()),
      },
      { additionalProperties: true },
    ),
    Type.Object({ result: RemoteObject, exceptionDetails: Type.Optional(ExceptionDetails) }),
  ),
  "Runtime.releaseObject": cmd(Type.Object({ objectId: Type.String() }), Empty),

  "DOM.getDocument": cmd(
    Type.Object({ depth: Type.Optional(Type.Number()), pierce: Type.Optional(Type.Boolean()) }),
    Type.Object({ root: Type.Object({ nodeId: Type.Number() }, { additionalProperties: true }) }),
  ),
  "DOM.querySelector": cmd(
    Type.Object({ nodeId: Type.Number(), selector: Type.String() }),
    Type.Object({ nodeId: Type.Number() }),
  ),
  "DOM.getBoxModel": cmd(
    Type.Object({ nodeId: Type.Optional(Type.Number()), backendNodeId: Type.Optional(Type.Number()) }),
    Type.Object({
      model: Type.Object(
        { content: Type.Array(Type.Number()), width: Type.Number(), height: Type.Number() },
        { additionalProperties: true },
      ),
    }),
  ),
  "DOM.resolveNode": cmd(
    Type.Object({ nodeId: Type.Optional(Type.Number()), backendNodeId: Type.Optional(Type.Number()) }),
    Type.Object({ object: RemoteObject }),
  ),
  "DOM.setFileInputFiles": cmd(
    Type.Object({
      files: Type.Array(Type.String()),
      nodeId: Type.Optional(Type.Number()),
      backendNodeId: Type.Optional(Type.Number()),
      objectId: Type.Optional(Type.String()),
    }),
    Empty,
  ),

  "Input.dispatchMouseEvent": cmd(
    Type.Object({
      type: MouseEventType,
      x: Type.Number(),
      y: Type.Number(),
      // Bit field: 1=Alt, 2=Ctrl, 4=Meta/Command, 8=Shift.
      modifiers: Type.Optional(Type.Integer()),
      timestamp: Type.Optional(Type.Number()),
      button: Type.Optional(MouseButton),
      // Bit field of pressed buttons: 1=Left, 2=Right, 4=Middle, 8=Back, 16=Forward.
      buttons: Type.Optional(Type.Integer()),
      clickCount: Type.Optional(Type.Integer()),
      force: Type.Optional(Type.Number()),
      tangentialPressure: Type.Optional(Type.Number()),
      tiltX: Type.Optional(Type.Number()),
      tiltY: Type.Optional(Type.Number()),
      twist: Type.Optional(Type.Integer()),
      deltaX: Type.Optional(Type.Number()),
      deltaY: Type.Optional(Type.Number()),
      pointerType: Type.Optional(Type.Union([Type.Literal("mouse"), Type.Literal("pen")])),
    }),
    Empty,
  ),
  "Input.dispatchKeyEvent": cmd(
    Type.Object({
      type: KeyEventType,
      modifiers: Type.Optional(Type.Integer()),
      timestamp: Type.Optional(Type.Number()),
      text: Type.Optional(Type.String()),
      unmodifiedText: Type.Optional(Type.String()),
      keyIdentifier: Type.Optional(Type.String()),
      code: Type.Optional(Type.String()),
      key: Type.Optional(Type.String()),
      windowsVirtualKeyCode: Type.Optional(Type.Integer()),
      nativeVirtualKeyCode: Type.Optional(Type.Integer()),
      autoRepeat: Type.Optional(Type.Boolean()),
      isKeypad: Type.Optional(Type.Boolean()),
      isSystemKey: Type.Optional(Type.Boolean()),
      // 0=Standard, 1=Left, 2=Right, 3=Numpad.
      location: Type.Optional(Type.Integer()),
      commands: Type.Optional(Type.Array(Type.String())),
    }),
    Empty,
  ),
  "Input.dispatchDragEvent": cmd(
    Type.Object({
      type: DragEventType,
      x: Type.Number(),
      y: Type.Number(),
      data: DragData,
      modifiers: Type.Optional(Type.Integer()),
    }),
    Empty,
  ),
  "Input.insertText": cmd(Type.Object({ text: Type.String() }), Empty),

  "Network.getResponseBody": cmd(
    Type.Object({ requestId: Type.String() }),
    Type.Object({ body: Type.String(), base64Encoded: Type.Optional(Type.Boolean()) }),
  ),
  "Network.setExtraHTTPHeaders": cmd(
    Type.Object({ headers: Type.Record(Type.String(), Type.String()) }),
    Empty,
  ),
  "Emulation.setDeviceMetricsOverride": cmd(
    Type.Object({
      // 0 disables the override for that dimension.
      width: Type.Integer(),
      height: Type.Integer(),
      // 0 disables the override.
      deviceScaleFactor: Type.Number(),
      mobile: Type.Boolean(),
      scale: Type.Optional(Type.Number()),
      screenWidth: Type.Optional(Type.Integer()),
      screenHeight: Type.Optional(Type.Integer()),
      positionX: Type.Optional(Type.Integer()),
      positionY: Type.Optional(Type.Integer()),
      dontSetVisibleSize: Type.Optional(Type.Boolean()),
      screenOrientation: Type.Optional(ScreenOrientation),
      viewport: Type.Optional(Viewport),
    }),
    Empty,
  ),
  "Accessibility.getFullAXTree": cmd(
    Type.Object({ depth: Type.Optional(Type.Number()), frameId: Type.Optional(Type.String()) }),
    Type.Object({ nodes: Type.Array(AxNode) }),
  ),
};

export type CdpMethod = keyof typeof COMMANDS;
export type ParamsOf<M extends CdpMethod> = Static<(typeof COMMANDS)[M]["params"]>;
export type ResultOf<M extends CdpMethod> = Static<(typeof COMMANDS)[M]["result"]>;

export const decodeResult = <M extends CdpMethod>(
  method: M,
  raw: unknown,
): Result<ResultOf<M>, CdpError> => {
  // `method` is a key of COMMANDS, so the lookup cannot miss.
  const spec = COMMANDS[method];
  if (!spec.validate.Check(raw)) {
    const why = spec.validate.Errors(raw).map((e) => e.message).join("; ");
    return err(cdpError("invalid_response", why, method));
  }
  // Guarded assertion: the check above proves `raw` matches COMMANDS[method].result. TS resolves
  // `spec.validate` through a generic key to the union of every validator, so the predicate
  // narrows `raw` to the union of every result type rather than to ResultOf<M>.
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- sanctioned decoder, see scripts/boundary-allowlist.ts
  return ok(raw as ResultOf<M>);
};
