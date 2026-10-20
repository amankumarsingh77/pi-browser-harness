// The node-side half of the page-function scheme.
//
// Page code lives in `*.page.ts` modules next to this file, type-checked by tsconfig.page.json against the DOM lib
// only. At runtime those modules are plain TypeScript functions that pi's loader (jiti) or tsx strips the types from,
// so `fn.toString()` is the exact JavaScript to ship into Chrome. Two consequences shape this file:
//   - a page function must be a `function` declaration, not an arrow: tsx emits `x=>...` for single-parameter arrows,
//     which is not a valid Runtime.callFunctionOn declaration, and jiti and tsx must agree on the leading token
//   - a page function must be self-contained (no module-scope references), because only its own text travels;
//     test/domains/page-functions-test.ts checks that for every exported page function
import { safeJs } from "../../util/js-template";

// Any page function. `this`-typed functions (the element handed over by Runtime.callFunctionOn) satisfy this too.
export type PageFunction = (...args: never[]) => unknown;

const DECLARATION = /^function\b/;

// The source text of a page function, as the `functionDeclaration` of Runtime.callFunctionOn. Throws at import time
// (callers evaluate it into module constants) when the loader has produced something other than a function declaration.
export const pageFunctionSource = (fn: PageFunction): string => {
  const source = fn.toString();
  if (!DECLARATION.test(source)) {
    throw new Error(
      `page function ${fn.name || "(anonymous)"} must be a \`function\` declaration; the loader produced: ${source.slice(0, 60)}`,
    );
  }
  return source;
};

// The `functionDeclaration` for Runtime.callFunctionOn of an ELEMENT function: one whose first parameter is the element.
// CDP hands the element over as `this`, so this wrapper forwards it as the first argument, keeping the page functions
// free of `this` (plain to type, plain to call in tests).
export const elementFunctionSource = (fn: PageFunction): string =>
  "function (...args) { return (" + pageFunctionSource(fn) + ")(this, ...args); }";

// An expression for Runtime.evaluate that calls the page function with `args`, each JSON-encoded through safeJs.
export const pageCallExpression = (fn: PageFunction, ...args: ReadonlyArray<unknown>): string =>
  "(" + pageFunctionSource(fn) + ")(" + args.map((a) => safeJs`${a}`).join(", ") + ")";
