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
npm run typecheck
npm pack --dry-run
```

`npm run typecheck` validates the TypeScript source. `npm pack --dry-run` verifies that the package can be packed for publishing and shows which files will be included.

---

## Project structure

```text
.
├── src/
│   ├── index.ts       # Extension entry point and command registration
│   ├── tools.ts       # Browser tool schemas, handlers, and result rendering hooks
│   ├── daemon.ts      # Connection lifecycle for the browser-harness daemon
│   ├── protocol.ts    # Types for browser/daemon protocol messages
│   ├── setup.ts       # /browser-setup implementation and Chrome detection
│   ├── state.ts       # Session state persistence
│   ├── prompt.ts      # Browser usage guidance injected into the agent prompt
│   └── renderers.ts   # TUI renderers for screenshots and tab listings
├── skills/
│   └── pi-browser-harness/
│       └── SKILL.md   # Agent skill documentation
├── README.md          # User-facing documentation
├── CHANGELOG.md       # Release notes
└── package.json       # npm package metadata and pi manifest
```

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

- Write TypeScript and keep the project passing `npm run typecheck`.
- Keep `strict` TypeScript mode clean. Do not introduce implicit `any` values.
- Prefer small, focused changes over broad rewrites.
- Keep tool descriptions, parameter descriptions, and prompt guidelines clear and user-facing.
- Preserve the existing error-handling style: return useful, actionable messages to the agent instead of leaking low-level details when possible.
- Avoid adding dependencies unless they are necessary for the browser-control experience.
- Keep README and CHANGELOG updates in the same PR when behavior changes.

---

## Adding a new browser tool

Most browser tools are registered in `src/tools.ts` through `pi.registerTool`.

When adding a tool:

1. Add or reuse the underlying daemon method in `src/daemon.ts` and protocol types in `src/protocol.ts` when needed.
2. Register the pi tool in `src/tools.ts` with:
   - a stable `browser_*` name,
   - a concise label and description,
   - a TypeBox parameter schema,
   - prompt snippets and guidelines that explain when to use it,
   - clear result text and structured details where useful.
3. Update prompt guidance in `src/prompt.ts` if the tool changes recommended workflows.
4. Add or update a renderer in `src/renderers.ts` if the tool returns visual or rich output.
5. Document the tool in `README.md` and note the change in `CHANGELOG.md`.
6. Run:

   ```bash
   npm run typecheck
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
   npm run typecheck
   npm pack --dry-run
   ```

5. Test in pi with a local path install when the change affects runtime behavior.
6. Update documentation and CHANGELOG entries when user-visible behavior changes.
7. Open a pull request against `main` and describe what changed, how it was tested, and any follow-up work.

Thank you for helping make browser automation in pi reliable, inspectable, and easy to use.
