# Codebase Refactor: Comments, Duplication, Architecture Contract, Type Safety

Date: 2026-07-26
Status: Approved

## Goal

Four outcomes, in one coordinated pass over `src/` and `test/`:

1. Comments removed from the codebase, keeping only load-bearing "why" notes.
2. Duplication, buggy code, and stale functions found and fixed.
3. A documented design flow plus a code pattern every tool must follow, so adding
   capabilities stays cheap.
4. Genuine 100% type safety — no unchecked assertion anywhere in `src/`.

## Starting Point

`src/` is ~10,120 lines across 70 files. `tsconfig.json` already enables `strict`,
`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess`, `noUnusedLocals`, and
`noImplicitReturns`. `tsc --noEmit` passes clean. A `Result<T, E>` type and a real
tool-definition pattern (`src/util/tool.ts`, `src/registry.ts`) already exist.

This is refinement of a sound design, not a rescue. The problems are:

- ~60 unchecked `as { ... }` casts at the CDP boundary, because
  `CdpSession.call` is typed `(method: string, params?: Record<string, unknown>)
  => Promise<Result<unknown, CdpError>>`. Strict flags cannot help; the lie is at
  the cast.
- `src/domains/forms.ts` (355 lines) is a stale fork of the live
  `src/domains/form.ts`, imported only by a manual test. The fork dropped two
  working tools: `fillFormTool` (batch fill) and `setCheckedTool`.
- `src/cdp/window-binding.ts` is dead code; nothing imports it, including its own
  test file.
- Per-tool `serialized: true` flags live in `registry.ts`, away from the tool
  definitions they describe.
- `test/` is not type-checked at all — `tsconfig.json` includes only
  `src/**/*.ts` — and has no runner script.
- ~1,560 comment lines (15% of `src/`), mixing file-header banners and
  restated-code noise with a small amount of genuinely load-bearing rationale.

## Decisions

| Question | Decision |
|---|---|
| Comment removal | Strip all decorative, header, and restating comments. Keep a small set of one-line "why" notes where code would otherwise look wrong. |
| CDP typing | Typed command map **and** runtime-validated decoders. |
| Behavior changes | Pure refactor, except: restore the two tools the `forms.ts` fork dropped. Real bugs get fixed and reported. |
| Tests | Type-check `test/`, and port the hand-rolled harness to `node:test` with `npm test` in CI. |

## A. Architecture — Dependencies Point Downward Only

```
index.ts            extension entry: flags, slash commands, session lifecycle hooks
  |
registry.ts         flat tool catalog: imports only, zero per-tool config
  |
util/tool.ts        tool runtime: liveness guard -> concurrency lock -> handler
                    -> Result-to-AgentToolResult conversion
  |
domains/*           one file per capability. Pure tool definitions.
                    The only layer expected to grow.
  |
client.ts           BrowserClient facade: session, ownership, mutation mutex,
                    profile pin
  |
cdp/session.ts      typed call/callOnTarget/callBrowser, event routing,
                    console + network buffers
  |
cdp/daemon-transport.ts -> daemon/*    out-of-process daemon owning the Chrome socket
  |
Chrome (CDP over WebSocket)
```

Side stacks:

- `profile/*` decides *which* Chrome and which profile to drive. Used by
  `index.ts` and `client.ts`; never by domains.
- `schemas/*` holds shared typebox arg fragments.
- `util/*` are dependency-free leaves.

The enforceable rule: **a `domains/*` file may import from `schemas/`, `util/`,
other `domains/`, and the `BrowserClient` type — never from `daemon/`,
`cdp/transport`, or `profile/`.** This holds today by accident; it becomes
documented and grep-checkable.

## B. One Typed, Validated CDP Boundary

45 distinct CDP methods are in use: 33 commands and 12 subscribed events. Small
enough to type exhaustively by hand.

New `src/cdp/commands.ts` holds a single table where a typebox schema per command
is the source of both the TypeScript types and the runtime validators, so the two
cannot drift:

```ts
const COMMANDS = {
  "Target.attachToTarget": {
    params: Type.Object({ targetId: Type.String(), flatten: Type.Optional(Type.Boolean()) }),
    result: Type.Object({ sessionId: Type.String() }),
  },
  "Browser.getWindowForTarget": {
    params: Type.Object({ targetId: Type.String() }),
    result: Type.Object({ windowId: Type.Number() }),
  },
  // ...33 entries
} as const;

call<M extends CdpMethod>(
  method: M,
  params: ParamsOf<M>,
): Promise<Result<ResultOf<M>, CdpError>>;
```

The session validates every response against its schema before resolving. A
malformed response becomes `err({ kind: "protocol", ... })` rather than a
`TypeError` three call frames later. `src/cdp/events.ts` gets the same treatment
for the 12 subscribed events, so handlers such as `Page.javascriptDialogOpening`
receive typed, validated params.

This single change removes all ~60 unchecked casts.

A named side benefit: a fully typed fake `BrowserClient` for tests becomes
trivial to write, which is what makes handler-level tool tests practical.

## C. Tool Authoring Contract

Every `domains/*` file must follow these nine rules. They go into
`docs/ARCHITECTURE.md` so they are reviewable rather than folklore.

1. **One domain per file**, exporting only `<name>Tool` consts plus helpers it
   owns. Past roughly 250 lines, split by capability. Current offenders:
   `snapshot.ts` (497), `forms.ts` (355).
2. **Args schema at the top of the file**, named `<Name>Args`, built with
   typebox, with a `description` on every field. Those strings are the agent's
   only documentation of the tool.
3. **`defineBrowserTool({ ... })` holds all metadata, including concurrency.**
   `concurrency: "serialized" | "parallel"` moves out of `registry.ts` into the
   definition. A tool's concurrency class must not live in a different file from
   the tool.
4. **Fixed handler signature:** `(args, ctx) => Promise<Result<ToolOk, ToolErr>>`.
   Never throw, never `console.log`, never touch `process`. Errors are values.
5. **Reach Chrome only via `ctx.client`.** No domain imports the transport.
6. **Element targeting goes through one shared `resolveTarget(client, args)`** in
   `domains/target.ts`, replacing the ref-vs-x/y branch currently copy-pasted
   into click, drag, scroll, and keyboard.
7. **CDP calls go through `cdpCall(client, method, params)`**, which pre-maps
   `CdpError` to `ToolErr`, retiring the
   `if (!r.success) return err({ kind: "cdp_error", ... })` couplet that follows
   nearly every call today.
8. **Naming:** tool name `browser_<verb>`, `label` title-case, `promptSnippet`
   one line, `promptGuidelines` at most six agent-facing bullets.
9. **Every tool has a test** at `test/domains/<name>-test.ts` covering its schema
   and its error paths, written against a fake client so no browser is needed.

## D. Reaching Actual 100% Type Safety

Strict flags are already clean, so every remaining hole is a place where the code
asserts instead of proving. Five enumerable categories:

1. **~60 CDP casts** — removed by section B. This is the bulk of the work.
2. **13 `JSON.parse` sites.** Six already parse to `unknown` and validate. Four
   cast straight to a shape: `domains/readpage/read-page.ts:34`,
   `domains/search/web-search.ts:112`, `cdp/discovery.ts:80`, `domains/js.ts:63`.
   All 13 get a typebox validator at the parse point, so no parsed value is ever
   trusted.
3. **4 `as unknown as` casts.** The three in `cdp/event-queue.ts` are an
   iterator-protocol workaround, fixed by typing the return as
   `IteratorResult<CdpEvent, undefined>` so a `done: true` result legitimately
   carries `undefined`. `util/tool.ts:102` fakes an `isError` field that the
   pi runtime reads by duck-typing; it is replaced by a declared
   `AgentToolResultWithError` type.
4. **9 non-null assertions.** Four `socket!` uses in `cdp/daemon-transport.ts`
   become a narrowed local const. Four `data.model!` uses in `domains/ref-resolve.ts`
   and `domains/snapshot.ts` disappear once `DOM.getBoxModel` is decoded.
   `domains/tabs.ts:107` (`matches[0]!`) becomes a real narrowing.
5. **1 `@ts-ignore`** in `util/sharp-shim.ts` for the optional `sharp` peer
   dependency, replaced by declaring the minimal interface actually used and
   typing the dynamic import against it.

**Config:** split into `tsconfig.base.json` holding the flags, plus
`tsconfig.json` for `src` and `tsconfig.test.json` for `test`, so `test/` is
type-checked for the first time. Add `noImplicitOverride`,
`verbatimModuleSyntax`, and `noUncheckedSideEffectImports`.

**Keeping it at 100%:** `scripts/check-boundaries.ts`, run by `npm run check`,
fails the build on any new `as any`, `as {`, `@ts-ignore`, or `!.` in `src/`.
Without this the casts grow back. A clean `tsc` is not evidence that there are no
unchecked casts — that is exactly the trap the codebase is in today.

## E. Duplication, Bugs, Stale Code

| # | Finding | Fix |
|---|---|---|
| 1 | `domains/forms.ts` (355 lines) is a stale fork of the live `form.ts`; it dropped `fillFormTool` and `setCheckedTool` | Port both tools onto the current pattern in `form.ts`, register them, delete `forms.ts`, repoint `test/manual/forms-test.ts` |
| 2 | `cdp/window-binding.ts` is dead — nothing imports it, not even its test | Delete it; fold window-id lookup into one `cdp/window.ts` |
| 3 | `Browser.getWindowForTarget` decoded at 5 sites | One `getWindowId(client, targetId)` |
| 4 | `Target.attachToTarget` decoded at 6 sites | One `attachTo(client, targetId)` |
| 5 | `Runtime.evaluate` unwrapping duplicated across `client.ts`, `cdp/target-factory.ts`, `domains/js.ts`, `domains/forms.ts`, `domains/snapshot.ts` | One `evaluate<T>(client, expr, decoder)` |
| 6 | Box-model unwrap duplicated at `domains/ref-resolve.ts:56-63` and `domains/snapshot.ts:364-371` | Shared `boxOf(client, nodeId)` |
| 7 | ref-vs-x/y resolution duplicated in click, drag, scroll, keyboard | Shared `resolveTarget` (contract rule 6) |
| 8 | `serialized` flags live in `registry.ts`, away from the tools | Move into each definition (contract rule 3) |
| 9 | Bug sweep across all 70 files | Each finding is reported with its fix; no semantics change silently beyond rows 1-8 |

Row 9 is deliberately open. The structural problems above are confirmed, but all
70 files have not yet been read closely enough to promise a specific bug count.
That audit happens during implementation, and each finding is surfaced rather
than folded into a refactor commit.

## F. Sequencing

Six commits, each with `tsc` green:

1. `chore(build): split tsconfig, typecheck tests, node:test runner and npm test`
   — the safety net lands before any behavior is touched.
2. `feat(cdp): typed command and event table with validated decoders` (section B)
3. `refactor(cdp): consolidate attach, window-id, evaluate, box-model helpers`
   (E rows 3-6)
4. `refactor(tools): concurrency in definitions, shared target resolution, CDP
   error mapping` (E rows 7-8)
5. `fix(domains): restore fillForm and setChecked, drop stale forms.ts and
   window-binding.ts` (E rows 1-2, plus audit fixes from row 9)
6. `docs: architecture and tool authoring contract`, then
   `refactor: strip comments`

Comment stripping is last on purpose. Done first, it would touch ~1,560 lines in
nearly every file and make all five substantive diffs unreviewable.

## Comment Removal Rule

To keep "a small set of load-bearing notes" from being a judgment call made
differently in every file, the rule is mechanical. Delete:

- every file-header block comment and section divider;
- every comment that restates what the next line does;
- every JSDoc block on a type or function whose name and signature already say it;
- every `TODO`/`ponytail:`/aside that is not actionable.

Keep a comment only when **all three** hold: it explains *why* rather than
*what*; the code would look like a bug or an accident without it; and it fits on
one line. Everything kept is rewritten to one line. Known keepers include the
`session_shutdown` note in `index.ts` explaining that the transport is
deliberately left alive to avoid a repeated Chrome permission prompt, and the CI
comment about Chromium's `ProcessSingleton` behavior. Expect roughly 20-30 such
lines total across `src/`, down from ~1,560.

Agent-facing strings — `description`, `promptSnippet`, `promptGuidelines`, and
typebox field descriptions — are **not comments** and are never touched.

## Testing Strategy

- Tools are tested at the handler level against a fake `BrowserClient`. The typed
  command table from section B makes that fake trivial and fully typed.
- Existing `test/profile/*` and `test/deep-research/*` suites port to `node:test`
  with their assertions intact.
- Browser-requiring scripts stay in `test/manual/` and stay manual.
- CI gains `npm test` alongside the existing typecheck and pack jobs.

## Out of Scope

- Any change to the daemon wire protocol or the profile-pinning behavior.
- New browser capabilities beyond restoring `fillFormTool` and `setCheckedTool`.
- Adding a linter. The boundary-check script covers the one invariant that
  matters here; a full ESLint setup is a separate decision.
- The unrelated research documents under `docs/`.
