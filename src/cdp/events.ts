import { Type, type Static, type TSchema } from "typebox";
import { Compile } from "typebox/compile";
import { type Result, err, ok } from "../util/result";
import { type CdpError, cdpError } from "./errors";

const ev = <P extends TSchema>(params: P) => ({ params, validate: Compile(params) });

const open = { additionalProperties: true } as const;

const Anything = Type.Object({}, open);

const StackTrace = Type.Object(
  {
    callFrames: Type.Optional(
      Type.Array(
        Type.Object(
          {
            url: Type.Optional(Type.String()),
            lineNumber: Type.Optional(Type.Number()),
            functionName: Type.Optional(Type.String()),
          },
          open,
        ),
      ),
    ),
  },
  open,
);

const ConsoleArg = Type.Object(
  {
    type: Type.Optional(Type.String()),
    value: Type.Optional(Type.Unknown()),
    description: Type.Optional(Type.String()),
    unserializableValue: Type.Optional(Type.String()),
  },
  open,
);

export const EVENTS = {
  "Inspector.detached": ev(Anything),

  "Page.javascriptDialogOpening": ev(
    Type.Object(
      {
        type: Type.String(),
        message: Type.String(),
        defaultPrompt: Type.Optional(Type.String()),
      },
      open,
    ),
  ),
  "Page.loadEventFired": ev(Anything),
  "Page.frameNavigated": ev(Anything),

  "Runtime.consoleAPICalled": ev(
    Type.Object(
      {
        type: Type.Optional(Type.String()),
        args: Type.Optional(Type.Array(ConsoleArg)),
        stackTrace: Type.Optional(StackTrace),
      },
      open,
    ),
  ),

  "Log.entryAdded": ev(
    Type.Object(
      {
        entry: Type.Object(
          {
            level: Type.Optional(Type.String()),
            text: Type.Optional(Type.String()),
            url: Type.Optional(Type.String()),
            lineNumber: Type.Optional(Type.Number()),
            stackTrace: Type.Optional(StackTrace),
          },
          open,
        ),
      },
      open,
    ),
  ),

  "Network.requestWillBeSent": ev(
    Type.Object(
      {
        requestId: Type.String(),
        request: Type.Object(
          {
            url: Type.String(),
            method: Type.String(),
            postData: Type.Optional(Type.String()),
          },
          open,
        ),
        type: Type.Optional(Type.String()),
      },
      open,
    ),
  ),
  "Network.responseReceived": ev(
    Type.Object(
      {
        requestId: Type.String(),
        response: Type.Optional(
          Type.Object(
            {
              status: Type.Optional(Type.Number()),
              statusText: Type.Optional(Type.String()),
              mimeType: Type.Optional(Type.String()),
            },
            open,
          ),
        ),
        type: Type.Optional(Type.String()),
      },
      open,
    ),
  ),
  "Network.loadingFinished": ev(
    Type.Object(
      { requestId: Type.String(), encodedDataLength: Type.Optional(Type.Number()) },
      open,
    ),
  ),
  "Network.loadingFailed": ev(
    Type.Object(
      { requestId: Type.String(), errorText: Type.Optional(Type.String()) },
      open,
    ),
  ),

  "Target.targetCreated": ev(
    Type.Object(
      {
        targetInfo: Type.Object(
          {
            targetId: Type.String(),
            type: Type.String(),
            openerId: Type.Optional(Type.String()),
          },
          open,
        ),
      },
      open,
    ),
  ),
  "Target.targetDestroyed": ev(Type.Object({ targetId: Type.String() }, open)),
};

export type CdpEventName = keyof typeof EVENTS;
export type EventParamsOf<E extends CdpEventName> = Static<(typeof EVENTS)[E]["params"]>;

export const isKnownEvent = (name: string): name is CdpEventName => Object.hasOwn(EVENTS, name);

export const decodeEvent = <E extends CdpEventName>(
  name: E,
  raw: unknown,
): Result<EventParamsOf<E>, CdpError> => {
  const spec = EVENTS[name];
  if (spec === undefined) {
    return err(cdpError("invalid_response", "unknown CDP event", name));
  }
  if (!spec.validate.Check(raw)) {
    const why = spec.validate.Errors(raw).map((e) => e.message).join("; ");
    return err(cdpError("invalid_response", why, name));
  }
  return ok(raw as EventParamsOf<E>);
};
