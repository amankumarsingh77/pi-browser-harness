# Architecture

How `pi-browser-harness` is put together, what each layer may depend on, and the rules a new
tool has to follow. Read the "Conventions that look like mistakes" section before you clean
anything up — several deliberate choices in this codebase look like typos.

The codebase carries almost no comments by policy. That makes this file the only place the
non-obvious conventions live.

---

## 1. Layers

Dependencies point downward only.

```
index.ts            extension entry: flags, slash commands, session lifecycle hooks
  |
registry.ts         flat tool catalog (ALL_TOOLS, 40 tools): imports only, zero per-tool config
  |
util/tool.ts        tool runtime: liveness guard -> concurrency lock -> handler
                    -> Result-to-AgentToolResult conversion
  |
domains/*           one file per capability. Tool files hold tools; shared logic
                    lives in helper-only modules beside them (cdp-call, ax-tree,
                    element-call, box, ref-resolve, fill-engine, isolated-tab,
                    screenshot-capture, target). The only layer expected to grow.
  |
domains/cdp-call.ts the ONLY door from a tool to the browser: cdpCall,
                    cdpCallOnTarget, cdpCallBrowser, evalJs, cdpErrToToolErr
  |
client.ts           BrowserClient facade: session, ownership, mutation mutex,
                    profile pin
  |
cdp/session.ts      typed call/callOnTarget/callBrowser, event routing,
                    console + network buffers
  |
daemon/transport.ts -> daemon/*        out-of-process daemon owning the Chrome socket
                    (CdpTransport is declared in cdp/types.ts)
  |
Chrome (CDP over WebSocket)
```

Side stacks:

| Directory | Role | Who may import it |
|---|---|---|
| `profile/*` | decides *which* Chrome and which profile to drive | `index.ts`, `setup.ts`, `client.ts` — never a domain |
| `schemas/*` | shared typebox arg fragments (`Coords`, `MouseButton`) and `parseJson` | anything |
| `util/*` | leaves — they import nothing from this repo except each other (`result`, `guards`, `mutex`, `truncate`, `paths`, `js-template`, `sharp-shim`, `debug`) | anything |

`src/util/tool.ts` sits in `util/` for locality but is not a leaf — it is the tool runtime layer
in the diagram above and imports `client` and `daemon/spawn`.

### The import rule for domains

A `domains/*` file may import from `schemas/`, `util/`, other `domains/`, the `BrowserClient`
type, and the *typed, session-level* parts of `cdp/` (`cdp/commands` types, `cdp/target-factory`,
the buffers, and `cdp/session` for the `CdpSession` type and `evaluateJson`).

**It must never import from `daemon/` or `profile/`.** A domain that reaches
the raw transport has escaped the validated boundary in section 2; a domain that reaches
`profile/` has coupled a tool to Chrome-launch policy.

The import rule itself is **not** machine-enforced — verify it by eye in review. What *is*
enforced is the narrower rule that matters most: two boundary-scanner rules, `raw-cdp-call` and
`raw-evaluate`, are scoped to `src/domains/` and fail the build when any file but `cdp-call.ts`
reaches `session.call*` or `evaluateJs` directly. The scope matters — `client.ts` and `cdp/` are
the layer that legitimately owns the session, so the rules deliberately do not apply there.

The rules match the two call shapes that exist today (`client.session().call…` and a `CdpSession`
held in a local named `session`). They are a guardrail, not a proof: renaming that local would
slip past them.

---

## 2. The CDP boundary

`src/cdp/commands.ts` (39 commands) and `src/cdp/events.ts` (13 events) are the single source
of truth for **both** the TypeScript types and the runtime validation. One typebox schema per
entry generates both, so they cannot drift.

```ts
const cmd = <P extends TSchema, R extends TSchema>(params: P, result: R) => ({
  params,
  result,
  validate: Compile(result),
});

export const COMMANDS = {
  "Target.attachToTarget": cmd(
    Type.Object({ targetId: Type.String(), flatten: Type.Optional(Type.Boolean()) }),
    Type.Object({ sessionId: Type.String() }),
  ),
  // ...
};

export type CdpMethod = keyof typeof COMMANDS;
export type ParamsOf<M extends CdpMethod> = Static<(typeof COMMANDS)[M]["params"]>;
export type ResultOf<M extends CdpMethod> = Static<(typeof COMMANDS)[M]["result"]>;
```

`decodeResult` validates every response before resolving; `decodeEvent` does the same for
subscribed events. A malformed payload becomes `err({ kind: "invalid_response", ... })` instead
of a `TypeError` three frames later.

### Adding a command

1. Add one `cmd(params, result)` entry to `COMMANDS`, keyed by the CDP method name.
2. Call it. `session.call(method, params)` and `cdpCall(client, method, params)` are already
   typed against the table. **No cast anywhere.**

### `additionalProperties: true` — the part that bites

`additionalProperties: true` makes the **runtime validator** permissive. It does **not** widen
the derived `Static<>` **type**. The consequence differs by direction, and getting it backwards
produces two different bugs:

| Schema | Under-specify | Over-specify |
|---|---|---|
| `params` | **compile error at the call site** — the field is not in `ParamsOf<M>`, so you cannot pass it | harmless |
| `result` / event params | field is simply unavailable to read | **silently dropped event or failed decode** when a future Chrome changes that field |

So:

- **Enumerate every field a call site passes.** Four of the six compile errors this refactor
  had to fix were exactly this: `Runtime.callFunctionOn`'s params schema omitted `arguments`,
  `returnByValue`, and `awaitPromise`, which the code genuinely sends.
- **On results and events, enumerate only what a consumer actually reads.** `Page.frameNavigated`
  and `Page.loadEventFired` are declared as fully-open objects with no enumerated fields
  (`ev(Anything)`) and never call `decodeEvent` at all — the session only needs to know they
  fired.

### How a tool reaches the browser

`src/domains/cdp-call.ts` is the only door, and the scanner enforces it (section 1):

| Helper | Use for |
|---|---|
| `cdpCall(client, method, params, opts?)` | the current tab |
| `cdpCallOnTarget(client, method, params, sessionId, opts?)` | a specific attached session |
| `cdpCallBrowser(client, method, params?, opts?)` | browser-level, no session |
| `evalJs(client, expression, sessionId?)` | evaluating JS, returns `unknown` |
| `cdpErrToToolErr(e, method)` | mapping a `CdpError` you got from elsewhere |

Each wraps the session call and maps `CdpError -> ToolErr`, so the
`if (!r.success) return err({ kind: "cdp_error", ... })` couplet is gone — a failed call is
returned as-is (`if (!r.success) return r;`).

`params` is **required** on `cdpCall`, unlike `session.call`. A no-argument CDP method needs an
explicit `{}`:

```ts
const r = await cdpCall(client, "Page.reload", {});
```

**A tool that wants to swallow a failure still goes through these helpers** — it just ignores the
error instead of returning it. `liveValue` in `src/domains/ax-tree.ts` returns `undefined` so the
caller falls back to the accessibility-tree value, and `snapshot`'s optional-screenshot block
simply omits the path. Both call `cdpCall` and discard the error. Reaching past the helper to
suppress an error is never the reason to do it.

One honest gap: `session.attach()` and `session.windowId()` are session methods that do perform a
CDP call, and `domains/navigate.ts` calls `attach` directly. The scanner's rules match `call*` and
`evaluateJs`, not these two.

---

## 3. Keeping the type safety

### A green `tsc` proves nothing about unchecked casts

`as { … }` between structurally compatible object types compiles **silently**. At one point this
codebase held 33 such casts and produced only 6 compile errors when they were removed. Strict
flags do not see them.

Likewise, **`JSON.parse` returns `any`, so an annotated assignment is an invisible cast.**
`let msg: CdpRawMessage = JSON.parse(raw)` typechecked cleanly in `src/daemon/bridge.ts` while
being completely unguarded — a `null` frame from Chrome would have thrown inside a `ws` handler
with no `try`/`catch` above it and killed the daemon. That is why `src/schemas/parse.ts` exists:
`parseJson(raw, validator)` parses to `unknown`, validates, and returns a `Result`. Every parse
boundary goes through it or an equivalent guard.

### The boundary scanner

`npm run boundaries` runs `scripts/check-boundaries.ts` over every `.ts` file under `src/` and
fails the build on five line-level patterns:

| Rule | Matches |
|---|---|
| `as-any` | `as any` |
| `ts-ignore` | `@ts-ignore`, `@ts-expect-error`, `@ts-nocheck` |
| `non-null-assertion` | `x!.`, `x!(`, `x!;` … |
| `inline-object-cast` | `as {` |
| `double-cast` | `as unknown as` |

Exemptions live in an **external allowlist**, `scripts/boundary-allowlist.ts`, as
`{ path, rule, count, reason }` entries. The `count` is a budget, not a flag: a *second*
violation of the same rule in an already-exempt file still fails the build.

The allowlist is deliberately external rather than a comment marker in the source, because the
zero-comments policy would eventually delete an in-source marker and turn CI red for an
unrecognisable reason. `unusedExemptions` also reports an entry whose code is gone, so the list
cannot rot.

**Limitations, stated rather than implied:** the scan is **line-based**, so a cast split across
two lines evades every rule. And it only walks `src/` — `test/` and `scripts/` are unscanned.

### The five surviving assertions in `src/`

All five are boundary assertions where a runtime check has already established the shape and
TypeScript cannot express the correlation.

| Location | Why |
|---|---|
| `decodeResult` in `src/cdp/commands.ts` | `validate.Check(raw)` proves `raw` matches `COMMANDS[method].result`; TS cannot correlate a generic key to its mapped value |
| `decodeEvent` in `src/cdp/events.ts` | same, for `EVENTS[name].params` |
| `loadSharp` in `src/util/sharp-shim.ts` (probe for `.default`) | the module comes from a dynamic import of an optional dependency, so its shape is unknown at compile time; the cast only claims an optional `.default`, and every value read off it is re-checked with `typeof` |
| `loadSharp` in `src/util/sharp-shim.ts` (`candidate` to `SharpFactory`) | `typeof candidate === "function"` was checked immediately above |
| `registerBrowserTool` in `src/util/tool.ts` (`renderCall` re-widening) | `AnyBrowserToolDefinition` is type-erased so the registry can hold a heterogeneous array; `defineBrowserTool` guarantees handler, parameters, and `renderCall` were built from the same `S` |

Only the `sharp-shim.ts` `.default` probe needs an allowlist entry, because it is the one written
as `as { … }`. The other four are `as SomeNamedType`, which no scanner rule matches. **Do not add
allowlist entries for them** — they are not required, and `unusedExemptions` would flag them.

---

## 4. The tool authoring contract

Nine rules. Every `domains/*` file follows them.

| # | Rule | Exemplar |
|---|---|---|
| 1 | **One domain per file, exporting only `<name>Tool` consts.** Anything a second file needs goes in a helper-only module beside it (`ax-tree.ts`, `element-call.ts`, `screenshot-capture.ts`, …) — never exported from a tool file. Past roughly 250 lines, split by capability. | `src/domains/history.ts` |
| 2 | **Args schema at the top of the file**, named `<Name>Args`, built with typebox, with a `description` on every field. Those strings are the agent's only documentation of the tool. | `src/domains/keyboard.ts` (`TypeArgs`, `PressKeyArgs`) |
| 3 | **`defineBrowserTool({ … })` holds all metadata, including `concurrency`.** A tool's concurrency class must not live in a different file from the tool. | every domain file |
| 4 | **Fixed handler signature** `(args, ctx) => Promise<Result<ToolOk, ToolErr>>`. Never throw, never `console.log`, never touch `process`. Errors are values. | `src/util/tool.ts` (`ToolHandler`) |
| 5 | **Reach Chrome only via `ctx.client`.** No domain imports the transport. | see section 1 |
| 6 | **Element targeting goes through the shared `resolveTarget(client, args)`** in `src/domains/target.ts` — never a hand-rolled ref-vs-x/y branch. | `src/domains/click.ts` |
| 7 | **CDP calls go through `src/domains/cdp-call.ts`** — `cdpCall`, `cdpCallOnTarget`, `cdpCallBrowser`, `evalJs`. Machine-enforced by the `raw-cdp-call` and `raw-evaluate` scanner rules. | `src/domains/history.ts` |
| 8 | **Naming:** tool name `browser_<verb>`, `label` title-case, `promptSnippet` one line, `promptGuidelines` at most six agent-facing bullets. | pinned by `test/domains/registry-test.ts` |
| 9 | **Every tool has a test** covering its schema and its error paths, written against a fake client so no browser is needed. | `test/domains/form-errors-test.ts` |

Rule 1's two standing exceptions are largely settled: `snapshot.ts` went from 477 lines to 256
once the tree model moved to `ax-tree.ts`, and `form.ts` from 409 to 283 once the element-call
machinery moved to `element-call.ts`. Both sit at the guidance rather than far past it. Neither
is licence to add a third.

Rule 6 currently binds only `src/domains/click.ts`, because it is the sole tool taking
*either* a ref *or* coordinates. `drag.ts` takes explicit coordinates only and `scroll.ts`
defaults to the viewport centre; neither resolves refs. Any *new* ref-or-coords tool must use
`resolveTarget`.

Rules 8 and 9 are partly machine-checked. `test/domains/registry-test.ts` asserts every tool
declares a concurrency class, that names are unique, that every name is `browser_`-prefixed, and
that the set of `serialized` tools is **exactly** a pinned list — so adding a serialized tool
means adding its name to `SERIALIZED` in that file.

---

## 5. How to add a tool

`src/domains/history.ts` (80 lines, three tools) is the whole pattern in one file. A minimal
tool, abridged from `reloadTool` in that file — the real one also branches on an open JS dialog:

```ts
import { Type } from "typebox";
import { type Result, err, ok } from "../util/result";
import { defineBrowserTool, type ToolErr, type ToolOk } from "../util/tool";
import { cdpCall } from "./cdp-call";

export const reloadTool = defineBrowserTool({
  name: "browser_reload",
  label: "Browser Reload",
  description: "Reload the current page.",
  promptSnippet: "Reload the page",
  promptGuidelines: ["Use to refresh the page, e.g. after server-side changes."],
  parameters: Type.Object({}),
  concurrency: "serialized",
  async handler(_a, { client }): Promise<Result<ToolOk, ToolErr>> {
    const r = await cdpCall(client, "Page.reload", {});
    if (!r.success) return r;
    const info = await client.pageInfo();
    if (!info.success) return err({ kind: "cdp_error", message: info.error.message });
    return ok({ text: `Reloaded: ${info.data.title}`, details: { page: info.data } });
  },
});
```

Note `if (!r.success) return r;` — a failed `cdpCall` is already a `Result<_, ToolErr>`, so it
returns unchanged. No re-wrapping.

Steps:

1. Create `src/domains/foo.ts`. Declare `FooArgs` at the top with a `description` on every field.
2. If the CDP method you need is not in `COMMANDS`, add a table entry first (section 2).
3. Call `defineBrowserTool` with an explicit `concurrency`. Pick `serialized` if the tool mutates
   page or session state; `parallel` only for pure reads.
4. Add the export to `ALL_TOOLS` in `src/registry.ts`.
5. If it is `serialized`, add its name to `SERIALIZED` in `test/domains/registry-test.ts`.
6. Write `test/domains/foo-test.ts`.

### Testing a handler

Use **`createFakeClient()`** from `test/domains/fake-client.ts`. It builds a real `CdpSession`
over a **stub transport** — canned per-method results, recorded calls, and an injectable event
stream:

```ts
const ctxFor = (fake: FakeClient): HandlerContext => ({
  client: fake.client,
  signal: undefined,
  onUpdate: () => {},
  extensionCtx: undefined as never,
});

const fake = await createFakeClient({
  refs: [{ ref: "e1", backendId: 101 }],
  canned: {
    "DOM.resolveNode": ok({ object: { type: "object", objectId: "obj-1" } }),
    "Runtime.callFunctionOn": ok({
      result: { type: "undefined" },
      exceptionDetails: { text: "Uncaught TypeError: el.dispatchEvent is not a function" },
    }),
  },
});
const r = await fillTool.handler({ ref: "e1", value: "x" }, ctxFor(fake));
assert.equal(r.success, false);
if (r.success) return;
assert.equal(r.error.kind, "cdp_error");
assert.match(r.error.message, /dispatchEvent is not a function/);
```

`canned` maps a CDP method to a `Result` (or a queue of them, consumed in order); `refs` seeds the
session's ref map so a `ref`-taking tool resolves without a snapshot; `evaluate` stubs
`client.evaluateJs`. `fake.calls` / `fake.callsTo(method)` are the recorded requests, and
`fake.emit(event)` injects a CDP event. `test/domains/form-errors-test.ts` is the reference usage.

**Do not mock the `BrowserClient` instead.** A mocked client bypasses the real session, the real
decoders, and the real error mapping, which produces a test that cannot fail. Two tasks on this
refactor shipped exactly that before `createFakeClient` existed.

It also exports `createStubTransport` (for session-level tests) and `axNode` (for
accessibility-tree fixtures).

---

## 6. Conventions that look like mistakes

Each of these has been, or would be, "fixed" by someone who did not know why it was written
that way.

**`src/util/tool.ts` gates the lock on `if (def.concurrency !== "parallel")`, not
`=== "serialized"`.** Deliberate fail-closed default: an unrecognised or missing concurrency
value **over-serialises** rather than racing on shared CDP session and page state. A test in
`test/domains/registry-test.ts` ("a definition with no concurrency class takes the mutation
mutex") pins it.

**`src/util/sharp-shim.ts` routes its dynamic import through
`const SHARP_SPECIFIER: string = "sharp"`** so TypeScript cannot resolve the specifier
statically. `sharp` is an **optional** dependency. **Anyone who "simplifies" this back to a
static `import("sharp")` breaks the build wherever sharp is absent.** This is the single most
likely thing in the codebase to be broken by a well-meaning cleanup.

**`npm test` passes `--conditions=import`.** A test can import a tool definition *only* because
of it: `@mariozechner/pi-coding-agent` publishes no `"require"` condition, and this repo is not
`"type": "module"`, so tsx would otherwise compile `src/` to CJS and the specifier would be
unresolvable. It also *matches* production — pi loads the extension with jiti and aliases that
package to `dist/index.js` by absolute path, which is what the `import` condition selects.

**The test glob is `test/{profile,domains,cdp,daemon,util}/**/*-test.ts`.** A test placed
in any other directory — `test/schemas/`, say — **silently never runs**, so adding a directory
means adding it here too. `test/manual/` is excluded on purpose: those need live Chrome.

**`Box` (`src/domains/box.ts`) has six fields — `x, y, width, height, cx, cy` — and all six are
consumed.** `cx`/`cy` are the click point. `width`/`height` reach the model through
`browser_snapshot` with `format: "json"`, which serialises each node's `box` wholesale.
Narrowing the type would silently change tool output.

---

## 7. The failure mode that cost the most rework

**Adopting a type guard where a loose truthiness check lived can invert a safety default.**

`if (guard(x)) { if (!x.ok) fail }` is **not** equivalent to `if (!x.ok) fail`. With an unchecked
cast, a malformed payload left the field `undefined`, so `!field` was **true** and the failure
path fired. Fold the guard into the boolean gate and a rejected shape now **skips the check
entirely** — the code proceeds in exactly the case where it knows least.

The structural tell, verified across six sites:

- **SAFE** — the guard produces a **value** that inherits a pre-existing failure path:
  ```ts
  const v = guard(x) ? x : undefined;
  if (v === undefined || !v.ok) return err(…);
  ```
- **UNSAFE** — the guard is **ANDed into a boolean gate**:
  ```ts
  if (ok && guard(x)) { … }
  ```

`typeTool` in `src/domains/keyboard.ts` has both halves within six lines. The inner line is the
safe form — `isFocusProbe(focused.data) ? focused.data : { ok: false, tag: null }` turns a bad
shape into a **value** meaning "not focused", which the existing `if (!f.ok)` then rejects. The
outer `if (focused.success)` is the same mistake in its other guise: a gate, so when the focus
probe itself fails the entire check is skipped and the tool types anyway. That is a known open bug
(F9 in the bug audit), left in place here as the clearest illustration in the tree.

Rule of thumb: **a check must default to the failure path when its input cannot be understood.**
If adding a guard moved a case from "fails loudly" to "not checked", the guard is in the wrong
place.

---

## 8. Recording the browser (`browser_record_start` / `browser_record_stop`)

**The active recording lives on `CdpSession`, not in `domains/` module scope.** `src/domains/`
has no module-level mutable state anywhere else — a `Map<namespace, Recorder>` there would be
the first, in the layer this doc calls "the only layer expected to grow" (section 1). `CdpSession`
already owns every other piece of per-connection mutable state (the per-tab console and network
buffers), and it is the only place a CDP event is routed (`consumeEvents`), which a
session-scoped recorder needs to receive `Page.screencastFrame`. So the recording slot sits
beside `tabs` in `createCdpSession`'s closure, one level above `TabSession` because a single
recording spans tab switches. `src/domains/record-session.ts` builds the `RecordingSink` (owns
the ffmpeg process and the file) and hands it to `session.startRecording`; `cdp/` never learns
what ffmpeg is — it sees an interface with `onFrame`, `noteInput`, `noteConsumerRestart`, and
`finalize`. That interface is declared in `src/cdp/types.ts`, not `src/domains/record-session.ts`,
because `cdp/` must not import from `domains/`.

**`Page.screencastFrame` is acked before the frame is handed to the sink, and the ack is never
awaited.** The ack is the protocol's only backpressure signal (NF1); waiting on the sink first
would make Chrome's frame delivery rate depend on encoder speed. `consumeEvents`'s case fires
`Page.screencastFrameAck` and calls `recording?.onFrame(...)` in the same synchronous turn,
without awaiting either.

**Four ffmpeg invocation facts, each a silent failure rather than an error message** (verified in
`library-probe.md` and while building this feature):

- `-framerate` must **precede** `-i`. After `-i pipe:0` ffmpeg ignores it and silently defaults
  to 25fps.
- The `image2pipe` demuxer cannot always find codec parameters for a raw JPEG stream on stdin —
  it fails with "Could not find codec parameters ... unknown codec" and a non-zero exit, not a
  warning. Passing `-vcodec mjpeg` before `-i` fixes it; omitting it works by luck on some input
  content and fails on others; it is not always audible.
- `-shortest` does **not** govern a filter graph — it only trims the top-level output. An overlay
  filter fed by an endless source (the slice-4 cursor sprite) needs `shortest=1` on the overlay
  filter itself, or ffmpeg never reaches EOF and hangs after stdin closes.
- Set `-thread_queue_size` explicitly; the default of 8 warns (and can stall) under a fast input.

A fifth, found only by actually killing a recording rather than by the probe: **`+frag_keyframe`
alone is not enough for NF3.** It emits a new fragment only at each keyframe, and libx264's default
GOP is several seconds; a process killed inside that window leaves a file with nothing past the
`ftyp` box. `-g <fps>` (roughly a one-second GOP) and `-flush_packets 1` (so a finished fragment
hits disk immediately rather than sitting in libavformat's output buffer until a clean close) are
both required for a killed recording to actually be playable.

**The cursor is composited in a second pass, and pass 1 writes the real output path.** `sendcmd`
parses its command script **once, when the filter graph is built**. Commands appended to the file
while ffmpeg is running are silently ignored — measured directly, not inferred: a command appended
one second into a run never took effect, and the overlay stayed at its initial position for the rest
of the video. Since the cursor track only exists once the recording ends, a live overlay is not
available, so `compositeCursor` runs a second ffmpeg pass at finalize.

That forces a non-obvious ordering. Pass 1 encodes straight to the **real** output path rather than
to a temp file, and pass 2 reads it, composites, and renames over it. Writing pass 1 to a temp file
would be the natural shape and would silently break NF3 — a recording killed mid-flight would leave
no file at the path the caller was given. A failed overlay pass is likewise reported
(`RecordingSummary.cursorFailed`) rather than thrown: the cursor-less capture is still the real
recording, and losing it to a cosmetic pass is the worse trade.

Two further `sendcmd` facts, both silent: commands sharing a timestamp are comma-separated **without
repeating the timestamp** (`0.5 overlay@cur x 100, overlay@cur y 100;`) — repeating it is a parse
error that kills the whole graph before a frame is written — and an overlay's position is only
re-evaluated per frame with `eval=frame`, otherwise it is fixed when the graph is constructed.

**Mouse input is tapped in one place.** `cdpCall` in `src/domains/cdp-call.ts` is the single door
every tool's CDP call already passes through, so the cursor track is collected there rather than in
`click.ts`, `scroll.ts` and `drag.ts` separately. One tap instead of four, and a future mouse-driven
tool is captured without being told to opt in. `noteInput` is a no-op when nothing is recording, so
the cost on the normal path is one string comparison. Coordinates are transformed into canvas space
at collection time (`toCanvasPoint`) using the same scale-and-pad the frames go through — a pointer
stored in raw viewport coordinates drifts out of alignment on any tab whose size differs from the
canvas.

**The duration cap finalizes through the same `RecordingSink` a caller would use, not through a
side channel.** `createRecordingSink` arms an unref'd `setTimeout` that calls `sink.finalize("capped")`
directly once `maxSeconds` elapses (R17/R18) — the same method `browser_record_stop` calls, so
window restoration, encoder close, and the cursor pass all run exactly as they do on a normal stop.
`finalize` clears that timer on every path, capped or not, so a normal stop does not leave a
pending cap timer to fire a second, erroring `finalize` call later.

That self-finalizing sink is still sitting in `CdpSession`'s recording slot when the cap fires —
nothing pops it, unlike an explicit `stopRecording()` call. Two callers need to tell it apart from
a still-running recording without adding a new `CdpSession` method: `browser_record_start`'s
duplicate check, and `browser_record_stop` recovering the summary a cap already produced instead of
calling `finalize` again (which would just error "already finalized" and lose the path). Both read
`RecordingSink.lastSummary()`, which is `null` until `finalize` first succeeds and holds that result
afterward — a capped-but-not-yet-cleared sink answers `lastSummary() !== null`, so a new
`browser_record_start` is accepted and simply overwrites the slot, and a following
`browser_record_stop` returns the retained summary rather than an error.

---

## 9. Running the checks

```bash
npm run check     # typecheck + boundaries + test
```

- `npm run typecheck` — `tsc --noEmit` over `src/`, then `tsc -p tsconfig.test.json` over
  `src/`, `test/`, and `scripts/`. Flags live in `tsconfig.base.json`; the notable ones beyond
  `strict` are `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`,
  `noPropertyAccessFromIndexSignature`, and `verbatimModuleSyntax`.
- `npm run boundaries` — the cast scanner (section 3).
- `npm test` — `node:test` over the glob above.

`npm run check` must be green before a PR.
