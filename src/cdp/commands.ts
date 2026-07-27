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

export const COMMANDS = {
  // --- Target ---
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

  // --- Browser ---
  "Browser.getWindowForTarget": cmd(
    Type.Object({ targetId: Type.Optional(Type.String()) }),
    Type.Object({ windowId: Type.Number(), bounds: Type.Optional(Type.Unknown()) }),
  ),
  "Browser.setDownloadBehavior": cmd(
    Type.Object({
      behavior: Type.String(),
      downloadPath: Type.Optional(Type.String()),
      eventsEnabled: Type.Optional(Type.Boolean()),
    }),
    Empty,
  ),

  // --- Page ---
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
      format: Type.Optional(Type.String()),
      quality: Type.Optional(Type.Number()),
      clip: Type.Optional(Type.Unknown()),
      captureBeyondViewport: Type.Optional(Type.Boolean()),
    }),
    Type.Object({ data: Type.String() }),
  ),
  "Page.printToPDF": cmd(Type.Object({}, { additionalProperties: true }), Type.Object({ data: Type.String() })),
  "Page.handleJavaScriptDialog": cmd(
    Type.Object({ accept: Type.Boolean(), promptText: Type.Optional(Type.String()) }),
    Empty,
  ),

  // --- Runtime ---
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

  // --- DOM ---
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

  // --- Input ---
  "Input.dispatchMouseEvent": cmd(Type.Object({}, { additionalProperties: true }), Empty),
  "Input.dispatchKeyEvent": cmd(Type.Object({}, { additionalProperties: true }), Empty),
  "Input.dispatchDragEvent": cmd(Type.Object({}, { additionalProperties: true }), Empty),
  "Input.insertText": cmd(Type.Object({ text: Type.String() }), Empty),

  // --- Network / Emulation / Accessibility ---
  "Network.getResponseBody": cmd(
    Type.Object({ requestId: Type.String() }),
    Type.Object({ body: Type.String(), base64Encoded: Type.Optional(Type.Boolean()) }),
  ),
  "Emulation.setDeviceMetricsOverride": cmd(Type.Object({}, { additionalProperties: true }), Empty),
  "Accessibility.getFullAXTree": cmd(
    Type.Object({ depth: Type.Optional(Type.Number()) }, { additionalProperties: true }),
    Type.Object({ nodes: Type.Array(Type.Unknown()) }),
  ),
};

export type CdpMethod = keyof typeof COMMANDS;
export type ParamsOf<M extends CdpMethod> = Static<(typeof COMMANDS)[M]["params"]>;
export type ResultOf<M extends CdpMethod> = Static<(typeof COMMANDS)[M]["result"]>;

export const decodeResult = <M extends CdpMethod>(
  method: M,
  raw: unknown,
): Result<ResultOf<M>, CdpError> => {
  const spec = COMMANDS[method];
  if (spec === undefined) {
    return err(cdpError("invalid_response", `unknown CDP method`, method));
  }
  if (!spec.validate.Check(raw)) {
    const why = spec.validate.Errors(raw).map((e) => e.message).join("; ");
    return err(cdpError("invalid_response", why, method));
  }
  // Guarded assertion — see Verified Fact 4. The Check above proves `raw`
  // matches COMMANDS[method].result; TS cannot correlate a generic key to its
  // mapped value, so this carries what the check established. The only
  // assertion in the CDP layer; do not add another.
  return ok(raw as ResultOf<M>);
};
