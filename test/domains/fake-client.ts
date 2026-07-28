import { createCdpSession, type CdpSession } from "../../src/cdp/session";
import { createOwnershipRegistry, type OwnershipRegistry } from "../../src/cdp/ownership";
import { type CdpError, cdpError } from "../../src/cdp/errors";
import type { CdpTransport } from "../../src/cdp/types";
import type { CdpEvent } from "../../src/cdp/types";
import type { BrowserClient } from "../../src/client";
import { createMutex } from "../../src/util/mutex";
import { type Result, err, ok } from "../../src/util/result";

export type RecordedCall = {
  readonly method: string;
  readonly params: Record<string, unknown>;
  readonly sessionId: string | null | undefined;
};

export type CannedResult = Result<unknown, CdpError>;

export type Canned = Record<string, CannedResult | ReadonlyArray<CannedResult>>;

export type StubTransport = {
  readonly transport: CdpTransport;
  readonly calls: RecordedCall[];
  readonly emit: (event: CdpEvent) => void;
  readonly closeQueue: () => void;
};

const DEFAULT_ATTACH: Canned = {
  "Target.setDiscoverTargets": ok({}),
  "Target.getTargets": ok({
    targetInfos: [{ targetId: "t1", type: "page", title: "Fake", url: "https://example.test/" }],
  }),
  "Target.attachToTarget": ok({ sessionId: "s1" }),
  "Browser.getWindowForTarget": ok({ windowId: 7 }),
};

export const createStubTransport = (canned: Canned = {}): StubTransport => {
  const calls: RecordedCall[] = [];
  const queues = new Map<string, CannedResult[]>();
  for (const [method, value] of Object.entries(canned)) {
    queues.set(method, Array.isArray(value) ? [...value] : [value]);
  }

  const buffered: CdpEvent[] = [];
  const waiters: Array<(v: IteratorResult<CdpEvent, undefined>) => void> = [];
  let ended = false;

  const next = (method: string): CannedResult => {
    const queue = queues.get(method);
    if (queue === undefined || queue.length === 0) return ok({});
    const head = queue.length === 1 ? queue[0] : queue.shift();
    return head ?? ok({});
  };

  const transport: CdpTransport = {
    connect: () => Promise.resolve(ok(undefined)),
    close: () => Promise.resolve(),
    request: (method, params, opts) => {
      calls.push({ method, params, sessionId: opts?.sessionId });
      return Promise.resolve(next(method));
    },
    events: (): AsyncIterable<CdpEvent> => ({
      [Symbol.asyncIterator]: (): AsyncIterator<CdpEvent, undefined, undefined> => ({
        next: (): Promise<IteratorResult<CdpEvent, undefined>> =>
          new Promise((resolve) => {
            const head = buffered.shift();
            if (head !== undefined) resolve({ value: head, done: false });
            else if (ended) resolve({ value: undefined, done: true });
            else waiters.push(resolve);
          }),
      }),
    }),
    state: () => "open",
    onClose: () => () => {},
  };

  return {
    transport,
    calls,
    emit: (event) => {
      const waiter = waiters.shift();
      if (waiter) waiter({ value: event, done: false });
      else buffered.push(event);
    },
    closeQueue: () => {
      ended = true;
      for (const w of waiters.splice(0)) w({ value: undefined, done: true });
    },
  };
};

export type FakeClientOptions = {
  readonly canned?: Canned;
  readonly evaluate?: (expression: string, sessionId?: string) => Result<unknown, CdpError>;
  readonly refs?: ReadonlyArray<{ readonly ref: string; readonly backendId: number; readonly sig?: string }>;
  readonly ownedTargetIds?: ReadonlyArray<string>;
};

export type FakeClient = {
  readonly client: BrowserClient;
  readonly session: CdpSession;
  readonly ownership: OwnershipRegistry;
  readonly calls: RecordedCall[];
  readonly emit: (event: CdpEvent) => void;
  readonly callsTo: (method: string) => ReadonlyArray<RecordedCall>;
  readonly evaluated: string[];
};

const notConfigured = <T>(what: string): Result<T, CdpError> =>
  err(cdpError("invalid_response", `fake client: ${what} was called but not configured`));

export const createFakeClient = async (opts: FakeClientOptions = {}): Promise<FakeClient> => {
  const stub = createStubTransport({ ...DEFAULT_ATTACH, ...(opts.canned ?? {}) });
  const ownership = createOwnershipRegistry({ ownedTargetIds: opts.ownedTargetIds ?? ["t1"] });
  const session = createCdpSession(stub.transport, ownership);
  const mutex = createMutex();
  const evaluated: string[] = [];

  const attached = await session.attachFirstPage();
  if (!attached.success) throw new Error(`fake client could not attach: ${attached.error.message}`);
  stub.calls.length = 0;

  if (opts.refs !== undefined) {
    const refMap = new Map<string, number>();
    const refSig = new Map<string, string>();
    for (const r of opts.refs) {
      refMap.set(r.ref, r.backendId);
      refSig.set(r.ref, r.sig ?? `textbox|${r.ref}||`);
    }
    session.setRefMap(refMap, refSig);
  }

  const client: BrowserClient = {
    namespace: "fake",
    ensureAlive: () => Promise.resolve(ok(undefined)),
    status: () => ({ alive: true, sessionId: attached.data.sessionId, namespace: "fake" }),
    start: () => Promise.resolve(ok(undefined)),
    stop: () => Promise.resolve(),
    detach: () => Promise.resolve(),
    closeOwnedTabs: () => Promise.resolve(),
    evaluateJs: (expression, sessionId) => {
      evaluated.push(expression);
      const run = opts.evaluate;
      if (run === undefined) return Promise.resolve(notConfigured<unknown>("evaluateJs"));
      return Promise.resolve(sessionId === undefined ? run(expression) : run(expression, sessionId));
    },
    pageInfo: () => Promise.resolve(notConfigured("pageInfo")),
    takeDialog: () => session.takeDialog(),
    listTabs: () => Promise.resolve(notConfigured("listTabs")),
    switchTab: () => Promise.resolve(notConfigured("switchTab")),
    newTab: () => Promise.resolve(notConfigured("newTab")),
    closeTab: () => Promise.resolve(ok(undefined)),
    owns: (id) => ownership.has(id),
    ownership: () => ownership,
    current: () => session.current(),
    session: () => session,
    transport: () => stub.transport,
    userDataDir: () => undefined,
    profilePin: () => null,
    setProfilePin: () => {},
    profileContextId: () => undefined,
    setProfileContextId: () => {},
    seedPinnedProfileWindow: () => Promise.resolve(notConfigured("seedPinnedProfileWindow")),
    mutationMutex: () => mutex,
  };

  return {
    client,
    session,
    ownership,
    calls: stub.calls,
    emit: stub.emit,
    callsTo: (method) => stub.calls.filter((c) => c.method === method),
    evaluated,
  };
};

export const axNode = (
  nodeId: string,
  role: string,
  name: string,
  extra: Readonly<Record<string, unknown>> = {},
): Readonly<Record<string, unknown>> => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  ...extra,
});
