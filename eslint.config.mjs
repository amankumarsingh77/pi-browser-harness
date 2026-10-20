// Type-aware ESLint for src/, test/ and scripts/. ESLint owns the cast policy
// (no `any`, no `as` to object literals, no non-null assertions, no unsafe
// member access); scripts/check-boundaries.ts owns the project-specific layer
// rules (raw CDP calls, raw evaluate, raw JS templates).
import eslint from "@eslint/js";
import tseslint from "typescript-eslint";

const LINTED = ["src/**/*.ts", "test/**/*.ts", "scripts/**/*.ts"];

export default tseslint.config(
  {
    ignores: [
      "node_modules/**",
      "dist/**",
      "docs/**",
      "benchmark/**",
      "data/**",
      "test/manual/**",
      ".claude/**",
      ".agents/**",
      ".worktrees/**",
      "*.js",
      "*.mjs",
      "*.cjs",
      "yt_*.js",
    ],
  },
  { files: LINTED, ...eslint.configs.recommended },
  ...tseslint.configs.strictTypeChecked.map((c) => ({ files: LINTED, ...c })),
  ...tseslint.configs.stylisticTypeChecked.map((c) => ({ files: LINTED, ...c })),
  {
    files: LINTED,
    languageOptions: {
      parserOptions: {
        // tsconfig.test.json is the one project that covers src/, test/ and
        // scripts/; tsconfig.json only covers src/, so the project service's
        // nearest-tsconfig lookup would leave test/ without a program.
        project: ["./tsconfig.test.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
    rules: {
      "@typescript-eslint/no-unsafe-argument": "error",
      "@typescript-eslint/no-unsafe-assignment": "error",
      "@typescript-eslint/no-unsafe-call": "error",
      "@typescript-eslint/no-unsafe-member-access": "error",
      "@typescript-eslint/no-unsafe-return": "error",
      "@typescript-eslint/no-unsafe-enum-comparison": "error",
      "@typescript-eslint/no-unsafe-function-type": "error",
      "@typescript-eslint/no-unsafe-type-assertion": "error",
      "@typescript-eslint/no-unsafe-unary-minus": "error",
      "@typescript-eslint/consistent-type-assertions": [
        "error",
        { assertionStyle: "as", objectLiteralTypeAssertions: "never", arrayLiteralTypeAssertions: "never" },
      ],
      "@typescript-eslint/no-non-null-assertion": "error",
      "@typescript-eslint/no-explicit-any": "error",
      // node:test's test/describe/it return a promise by design; every test
      // file calls them at the top level, so they are the one sanctioned
      // un-awaited call. Everything else must be awaited or handled.
      "@typescript-eslint/no-floating-promises": [
        "error",
        {
          allowForKnownSafeCalls: [
            { from: "package", package: "node:test", name: ["test", "describe", "it", "suite"] },
          ],
        },
      ],
      "@typescript-eslint/switch-exhaustiveness-check": "error",
      "@typescript-eslint/consistent-type-imports": [
        "error",
        { prefer: "type-imports", fixStyle: "inline-type-imports" },
      ],
      // Project conventions: `type` aliases everywhere (no interfaces), and
      // ReadonlyArray<T> spelled out as the generic rather than `readonly T[]`.
      "@typescript-eslint/consistent-type-definitions": ["error", "type"],
      "@typescript-eslint/array-type": ["error", { default: "array-simple", readonly: "generic" }],
      // strictTypeChecked forbids numbers and booleans in `${}`; the codebase
      // formats counts, sizes and flags into messages on nearly every file, so
      // allow the primitives whose String() form is unambiguous.
      "@typescript-eslint/restrict-template-expressions": [
        "error",
        { allowNumber: true, allowBoolean: true },
      ],
    },
  },
  {
    // Page-side functions (shipped into Chrome as source text) are excluded from
    // the node projects and type-checked against the DOM lib by tsconfig.page.json.
    files: ["src/domains/page/*.page.ts"],
    languageOptions: {
      parserOptions: {
        project: ["./tsconfig.page.json"],
        tsconfigRootDir: import.meta.dirname,
      },
    },
  },
);
