// Project-specific layer rules that no generic linter knows about.
//
// Division of labour with ESLint (eslint.config.mjs):
//   - ESLint owns the cast policy. @typescript-eslint/consistent-type-assertions,
//     no-explicit-any, no-non-null-assertion, no-unsafe-* and ban-ts-comment are
//     type-aware and catch every spelling (`<T>x`, `as string`, `satisfies`,
//     bare `Function`/`object`, assertions split across lines). The cast rules
//     kept below are a cheap textual backstop for src/ only, retained because
//     boundary-allowlist.ts budgets them; they are not extended further.
//   - This script owns the rules that need project knowledge:
//       raw-cdp-call     a tool under src/domains reaches the CDP session
//                        directly instead of going through domains/cdp-call.ts
//       raw-evaluate     a tool calls client.evaluateJs instead of evalJs
//       raw-js-template  a template literal with `${}` interpolation is handed
//                        straight to evalJs / evaluateJs / evaluateJson /
//                        evalInIsolatedTab or to an `expression:` field without
//                        going through safeJs (src/util/js-template.ts); scanned
//                        in src/ and test/
//
// Matching runs on a copy of each file with comments, string literals, regex
// literals and template bodies blanked out (ranges taken from the TypeScript
// parser), so prose never trips a rule. The one exception is ts-ignore, which
// by nature lives in a comment. Templates keep a `${}` marker when they
// interpolate and are tagged with anything other than safeJs; that marker is
// what raw-js-template looks for.
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import ts from "typescript";
import { ALLOWLIST, type Exemption } from "./boundary-allowlist";

export type { Exemption };

export type Violation = {
  readonly path: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
};

type Rule = {
  readonly rule: string;
  readonly re: RegExp;
  // Which files the rule applies to; unset means src/ only (the cast backstop).
  readonly scope?: RegExp;
  readonly exclude?: RegExp;
  // "raw" matches the original line (needed for comment-borne markers),
  // "stripped" matches the line with literals and comments blanked,
  // "file" matches the whole stripped file so a call spanning lines still hits.
  // "file" rules match across lines and must carry the g flag for matchAll.
  readonly on: "raw" | "stripped" | "file";
};

// The cast backstop skips test/ and scripts/, where ESLint alone is the authority.
const CAST_SCOPE = /^(?!test\/|scripts\/)/;
const TOOL_LAYER = /^src\/domains\//;
const EVERYWHERE = /^(?:src|test)\//;

// Arguments between the call's "(" and the raw template: anything but a bare
// backtick, with one level of nested parentheses allowed for helper calls.
const CALL_ARGS = "(?:[^()`]|\\([^()`]*\\))*?";

const RULES: ReadonlyArray<Rule> = [
  { rule: "as-any", re: /\bas\s+any\b/, on: "stripped" },
  { rule: "ts-ignore", re: /@ts-(ignore|expect-error|nocheck)/, on: "raw" },
  { rule: "non-null-assertion", re: /[A-Za-z_$)\]]!\s*(?:[.[(;,)\]}]|$)/, on: "stripped" },
  { rule: "inline-object-cast", re: /\bas\s+\{/, on: "stripped" },
  { rule: "double-cast", re: /\bas\s+unknown\s+as\b/, on: "stripped" },
  { rule: "named-cast", re: /\bas\s+(?:new\s+)?[A-Z][A-Za-z0-9_]*/, on: "stripped" },
  { rule: "function-cast", re: /\bas\s+\(/, on: "stripped" },
  { rule: "trailing-cast", re: /\bas\s*$/, on: "stripped" },
  { rule: "raw-cdp-call", re: /(?:session\(\)|\bsession)\.call(?:OnTarget|Browser)?\(/, scope: TOOL_LAYER, on: "stripped" },
  { rule: "raw-evaluate", re: /\.evaluateJs\(/, scope: TOOL_LAYER, on: "stripped" },
  {
    rule: "raw-js-template",
    re: new RegExp(
      `\\b(?:evalJs|evaluateJs|evaluateJson|evalInIsolatedTab)\\(${CALL_ARGS}\`\\$\\{\\}` + "|" + "\\bexpression:\\s*`\\$\\{\\}",
      "g",
    ),
    scope: EVERYWHERE,
    exclude: /^src\/util\/js-template\.ts$/,
    on: "file",
  },
];

export type SourceFile = { readonly path: string; readonly text: string };

const normalise = (path: string): string => path.split("\\").join("/");

const key = (path: string, rule: string): string => `${normalise(path)}\u0000${rule}`;

const SAFE_TAG = "safeJs";

// Returns the source with every comment, string, regex and template body replaced by spaces,
// keeping newlines so line numbers still line up. A template that interpolates and is not
// tagged safeJs leaves a `${}` marker right after its opening backtick. The ranges come from
// the TypeScript parser, so regex-versus-division, nested templates and strings containing
// comment openers are all resolved the way the compiler resolves them.
export const stripLiterals = (src: string): string => {
  const sf = ts.createSourceFile("scan.ts", src, ts.ScriptTarget.Latest, true, ts.ScriptKind.TS);
  const blank = new Uint8Array(src.length);
  const markers = new Set<number>();
  const seenComments = new Set<number>();

  const blankRange = (from: number, to: number): void => {
    for (let i = from; i < to; i++) if (src[i] !== "\n") blank[i] = 1;
  };
  const blankComments = (ranges: ReadonlyArray<ts.CommentRange> | undefined): void => {
    for (const r of ranges ?? []) {
      if (seenComments.has(r.pos)) continue;
      seenComments.add(r.pos);
      blankRange(r.pos, r.end);
    }
  };
  const isSafeTagged = (node: ts.Node): boolean =>
    ts.isTaggedTemplateExpression(node.parent) && node.parent.template === node && node.parent.tag.getText(sf) === SAFE_TAG;

  const visit = (node: ts.Node): void => {
    blankComments(ts.getLeadingCommentRanges(src, node.getFullStart()));
    blankComments(ts.getTrailingCommentRanges(src, node.getEnd()));
    if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) {
      blankRange(node.getStart(sf) + 1, node.getEnd() - 1);
      return;
    }
    if (ts.isRegularExpressionLiteral(node)) {
      // Keep both slashes and the flags; only the pattern is prose-like.
      blankRange(node.getStart(sf) + 1, src.lastIndexOf("/", node.getEnd() - 1));
      return;
    }
    if (ts.isTemplateExpression(node)) {
      // The interpolations hold ordinary code, but they are blanked wholesale with the body: a
      // nested literal cannot end the template early, and the rules never need to see inside.
      const open = node.getStart(sf);
      blankRange(open + 1, node.getEnd() - 1);
      if (!isSafeTagged(node)) markers.add(open + 1);
      return;
    }
    ts.forEachChild(node, visit);
  };
  visit(sf);
  blankComments(ts.getLeadingCommentRanges(src, sf.endOfFileToken.getFullStart()));

  let out = "";
  for (let i = 0; i < src.length; i++) {
    if (markers.has(i)) out += "${}";
    out += blank[i] ? " " : src.charAt(i);
  }
  return out;
};

const budgets = (exemptions: ReadonlyArray<Exemption>): Map<string, number> => {
  const out = new Map<string, number>();
  for (const e of exemptions) out.set(key(e.path, e.rule), (out.get(key(e.path, e.rule)) ?? 0) + e.count);
  return out;
};

const applies = (rule: Rule, path: string): boolean => {
  if (rule.exclude?.test(path)) return false;
  return (rule.scope ?? CAST_SCOPE).test(path);
};

const lineOf = (text: string, index: number): number => {
  let line = 1;
  for (let i = 0; i < index; i++) if (text[i] === "\n") line++;
  return line;
};

const rawHits = (files: ReadonlyArray<SourceFile>): ReadonlyArray<Violation> => {
  const out: Violation[] = [];
  for (const file of files) {
    const path = normalise(file.path);
    const rawLines = file.text.split("\n");
    const stripped = stripLiterals(file.text);
    const strippedLines = stripped.split("\n");
    for (const rule of RULES) {
      if (!applies(rule, path)) continue;
      if (rule.on === "file") {
        for (const m of stripped.matchAll(rule.re)) {
          const line = lineOf(stripped, m.index);
          out.push({ path: file.path, line, rule: rule.rule, text: (rawLines[line - 1] ?? "").trim() });
        }
        continue;
      }
      const lines = rule.on === "raw" ? rawLines : strippedLines;
      for (const [i, line] of lines.entries()) {
        if (rule.re.test(line)) out.push({ path: file.path, line: i + 1, rule: rule.rule, text: (rawLines[i] ?? "").trim() });
      }
    }
  }
  return out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : a.line - b.line));
};

export const checkSource = (
  files: ReadonlyArray<SourceFile>,
  exemptions: ReadonlyArray<Exemption> = ALLOWLIST,
): ReadonlyArray<Violation> => {
  const remaining = budgets(exemptions);
  const out: Violation[] = [];
  for (const hit of rawHits(files)) {
    const k = key(hit.path, hit.rule);
    const budget = remaining.get(k) ?? 0;
    if (budget > 0) {
      remaining.set(k, budget - 1);
      continue;
    }
    out.push(hit);
  }
  return out;
};

export const unusedExemptions = (
  files: ReadonlyArray<SourceFile>,
  exemptions: ReadonlyArray<Exemption> = ALLOWLIST,
): ReadonlyArray<Exemption> => {
  const seen = new Map<string, number>();
  for (const hit of rawHits(files)) {
    const k = key(hit.path, hit.rule);
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }
  return exemptions.filter((e) => (seen.get(key(e.path, e.rule)) ?? 0) < e.count);
};

const walk = (dir: string): ReadonlyArray<string> =>
  existsSync(dir)
    ? readdirSync(dir)
        .sort()
        .flatMap((name) => {
          const p = join(dir, name);
          return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
        })
    : [];

const main = (): void => {
  const files = [...walk("src"), ...walk("test")].map((path) => ({ path: normalise(path), text: readFileSync(path, "utf8") }));
  const violations = checkSource(files);
  const stale = unusedExemptions(files);

  for (const e of ALLOWLIST) {
    console.log(`boundary check: exemption ${e.path} [${e.rule}] x${e.count} — ${e.reason}`);
  }
  for (const e of stale) {
    console.log(`boundary check: exemption ${e.path} [${e.rule}] is stale, the code it covered is gone — delete it`);
  }

  if (violations.length === 0) {
    console.log(`boundary check: clean (${files.length} files, ${ALLOWLIST.length} exemption(s))`);
    return;
  }
  for (const v of violations) console.error(`${v.path}:${v.line} [${v.rule}] ${v.text}`);
  console.error(`\nboundary check: ${violations.length} violation(s)`);
  process.exitCode = 1;
};

if (process.argv[1]?.endsWith("check-boundaries.ts")) main();
