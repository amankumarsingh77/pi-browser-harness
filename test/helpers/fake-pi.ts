// Recording fakes for the slices of pi's ExtensionAPI / ExtensionContext that the extension, the
// setup command and the profile command touch. pi's real types are far wider, so each fake is a
// plain record erased to the host type once, at the end, the same way every other test fake is.

import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";

export type RecordedFlag = { readonly name: string; readonly type: string; readonly defaultValue: unknown };

export type RecordedCommand = {
  readonly name: string;
  readonly description: string | undefined;
  readonly handler: (args: string, ctx: ExtensionContext) => Promise<void> | void;
};

export type RecordedNotice = { readonly message: string; readonly type: string | undefined };

export type RecordedUserMessage = { readonly content: unknown; readonly options: unknown };

export type EventHandler = (event: unknown, ctx: ExtensionContext) => unknown;

export type FakePi = {
  readonly pi: ExtensionAPI;
  readonly flags: ReadonlyArray<RecordedFlag>;
  readonly commands: ReadonlyArray<RecordedCommand>;
  readonly tools: ReadonlyArray<string>;
  // The registered definition, so a test can run a tool's execute the way pi does.
  readonly tool: (name: string) => ToolDefinition;
  readonly events: ReadonlyArray<string>;
  readonly entries: ReadonlyArray<{ readonly customType: string; readonly data: unknown }>;
  readonly flagReads: ReadonlyArray<string>;
  // Every message the extension handed to the agent, which starts a model turn, with its delivery options.
  readonly userMessages: ReadonlyArray<RecordedUserMessage>;
  readonly setFlag: (name: string, value: unknown) => void;
  readonly command: (name: string) => RecordedCommand;
  readonly emit: (event: string, payload: unknown, ctx: ExtensionContext) => Promise<unknown>;
};

export const fakePi = (): FakePi => {
  const flags: RecordedFlag[] = [];
  const commands: RecordedCommand[] = [];
  const tools: string[] = [];
  const toolDefs = new Map<string, ToolDefinition>();
  const events: string[] = [];
  const entries: Array<{ readonly customType: string; readonly data: unknown }> = [];
  const flagReads: string[] = [];
  const userMessages: RecordedUserMessage[] = [];
  const flagValues = new Map<string, unknown>();
  const handlers = new Map<string, EventHandler[]>();

  const shape = {
    registerFlag: (name: string, opts: { readonly type: string; readonly default?: unknown }) => {
      flags.push({ name, type: opts.type, defaultValue: opts.default });
    },
    registerCommand: (name: string, opts: { readonly description?: string; readonly handler: RecordedCommand["handler"] }) => {
      commands.push({ name, description: opts.description, handler: opts.handler });
    },
    registerTool: (td: ToolDefinition) => {
      tools.push(td.name);
      toolDefs.set(td.name, td);
    },
    getFlag: (name: string): unknown => {
      flagReads.push(name);
      return flagValues.get(name);
    },
    appendEntry: (customType: string, data: unknown) => {
      entries.push({ customType, data });
    },
    sendUserMessage: (content: unknown, options?: unknown) => {
      userMessages.push({ content, options });
    },
    on: (event: string, handler: EventHandler) => {
      events.push(event);
      const list = handlers.get(event) ?? [];
      list.push(handler);
      handlers.set(event, list);
    },
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- partial fake of pi's wide API
  const pi = shape as unknown as ExtensionAPI;

  return {
    pi,
    flags,
    commands,
    tools,
    tool: (name) => {
      const found = toolDefs.get(name);
      if (!found) throw new Error(`tool ${name} was not registered`);
      return found;
    },
    events,
    entries,
    flagReads,
    userMessages,
    setFlag: (name, value) => {
      flagValues.set(name, value);
    },
    command: (name) => {
      const found = commands.find((c) => c.name === name);
      if (!found) throw new Error(`command ${name} was not registered`);
      return found;
    },
    emit: async (event, payload, ctx) => {
      const list = handlers.get(event) ?? [];
      let last: unknown;
      for (const h of list) last = await h(payload, ctx);
      return last;
    },
  };
};

export type FakeCtxOptions = {
  readonly hasUI?: boolean;
  // Answers `ui.select` in order; undefined (or running out) means the user escaped.
  readonly selections?: ReadonlyArray<string | undefined>;
  readonly branch?: ReadonlyArray<unknown>;
  readonly sessionId?: string;
  // Answers `ui.confirm` in order; running out means the user declined.
  readonly confirms?: ReadonlyArray<boolean>;
  readonly cwd?: string;
  // What `isIdle()` answers; the agent is idle unless a test says it is busy.
  readonly idle?: boolean;
};

export type FakeCtx = {
  readonly ctx: ExtensionContext;
  readonly notices: ReadonlyArray<RecordedNotice>;
  readonly prompts: ReadonlyArray<{ readonly title: string; readonly options: ReadonlyArray<string> }>;
  readonly confirmations: ReadonlyArray<{ readonly title: string; readonly message: string }>;
};

export const fakeCtx = (opts: FakeCtxOptions = {}): FakeCtx => {
  const notices: RecordedNotice[] = [];
  const prompts: Array<{ readonly title: string; readonly options: ReadonlyArray<string> }> = [];
  const confirmations: Array<{ readonly title: string; readonly message: string }> = [];
  const answers = [...(opts.selections ?? [])];
  const confirmAnswers = [...(opts.confirms ?? [])];
  const shape = {
    hasUI: opts.hasUI ?? true,
    ui: {
      notify: (message: string, type?: string) => {
        notices.push({ message, type });
      },
      select: (title: string, options: string[]): Promise<string | undefined> => {
        prompts.push({ title, options: [...options] });
        return Promise.resolve(answers.shift());
      },
      confirm: (title: string, message: string): Promise<boolean> => {
        confirmations.push({ title, message });
        return Promise.resolve(confirmAnswers.shift() ?? false);
      },
    },
    cwd: opts.cwd ?? process.cwd(),
    isIdle: () => opts.idle ?? true,
    sessionManager: { getBranch: () => [...(opts.branch ?? [])], getSessionId: () => opts.sessionId ?? "fake-session" },
  };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- only hasUI, cwd, isIdle, ui.notify/select/confirm and sessionManager.getBranch/getSessionId are read
  const ctx = shape as unknown as ExtensionContext;
  return { ctx, notices, prompts, confirmations };
};
