# Contributing to pi-browser-harness

Thanks for your interest in improving `pi-browser-harness`. This project gives pi agents full browser control through the Chrome DevTools Protocol (CDP): navigation, screenshots, clicks, typing, JavaScript evaluation, tab management, and runtime helper scripts.

---

## Setup

### 1. Fork and clone

```bash
git clone https://github.com/YOUR_USERNAME/pi-browser-harness.git
cd pi-browser-harness
```

If you are working directly from the upstream repository:

```bash
git clone https://github.com/amankumarsingh77/pi-browser-harness.git
cd pi-browser-harness
```

### 2. Install dependencies

```bash
npm install
```

### 3. Run the local checks

```bash
npm run check
npm pack --dry-run
```

`npm run check` runs the typecheck, the type-safety boundary scan, and the test suite. All three must pass before a PR. `npm pack --dry-run` verifies that the package can be packed for publishing and shows which files will be included.

---

## Architecture

Read [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) before making a non-trivial change. It covers:

- the layer diagram and which directories a `domains/*` file may and may not import from,
- the typed and runtime-validated CDP boundary in `src/cdp/commands.ts` and `src/cdp/events.ts`, and how to add a command,
- the nine-rule tool authoring contract,
- an end-to-end worked example of adding a tool and testing it against the fake client,
- the conventions in this codebase that look like mistakes but are not.

The source carries almost no comments by policy, so that document is where the non-obvious conventions live.

---

## Developing locally

Make changes in `src/`, then run:

```bash
npm run typecheck
```

To test the extension in pi from your local checkout, install it by path:

```bash
pi install /absolute/path/to/pi-browser-harness
```

For example:

```bash
pi install "$PWD"
```

Then start pi and run:

```text
/browser-setup
/browser-status
```

Use the normal browser workflow when testing: screenshot → act → screenshot → verify. For example, navigate to a page, wait for load, capture a screenshot, and confirm the result visually.

---

## Code conventions

- Write TypeScript and keep the project passing `npm run check`.
- Keep `strict` TypeScript mode clean. Do not introduce implicit `any` values.
- No unchecked casts. `npm run boundaries` fails the build on `as any`, `as {`, `as unknown as`, `@ts-ignore`, and non-null assertions in `src/`. A green `tsc` is not evidence of type safety — see `docs/ARCHITECTURE.md` section 3.
- Prefer no comments. Explain a non-obvious convention in `docs/ARCHITECTURE.md`, not inline.
- Prefer small, focused changes over broad rewrites.
- Keep tool descriptions, parameter descriptions, and prompt guidelines clear and user-facing.
- Preserve the existing error-handling style: return useful, actionable messages to the agent instead of leaking low-level details when possible.
- Avoid adding dependencies unless they are necessary for the browser-control experience.
- Keep README and CHANGELOG updates in the same PR when behavior changes.

---

## Adding a new browser tool

The full worked example is in [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) — section 4 (the contract) and section 5 (the steps). In short: one file under `src/domains/`, a typebox args schema at the top, a `defineBrowserTool` call carrying its own `concurrency`, an entry in `ALL_TOOLS` in `src/registry.ts`, and a test under `test/domains/` written against `createFakeClient`.

Beyond that:

1. Update prompt guidance in `src/prompt.ts` if the tool changes recommended workflows.
2. Document the tool in `README.md` and note the change in `CHANGELOG.md`.
3. Run:

   ```bash
   npm run check
   npm pack --dry-run
   ```

Keep tool behavior predictable. The agent should be able to verify actions with screenshots or page state after every interaction.

---

## Pull request process

1. Fork the repository.
2. Create a focused branch:

   ```bash
   git checkout -b fix/short-description
   ```

3. Make your changes and keep commits readable.
4. Run local checks:

   ```bash
   npm run check
   npm pack --dry-run
   ```

   `npm run check` must be green before the PR is opened.

5. Test in pi with a local path install when the change affects runtime behavior.
6. Update documentation and CHANGELOG entries when user-visible behavior changes.
7. Open a pull request against `main` and describe what changed, how it was tested, and any follow-up work.

Thank you for helping make browser automation in pi reliable, inspectable, and easy to use.
