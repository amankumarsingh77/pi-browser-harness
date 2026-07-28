import { readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { ALLOWLIST, type Exemption } from "./boundary-allowlist";

export type { Exemption };

export type Violation = {
  readonly path: string;
  readonly line: number;
  readonly rule: string;
  readonly text: string;
};

// `scope` restricts a rule to one layer: the tool layer must go through domains/cdp-call.ts, while cdp/ and client.ts are the layer that owns the session.
const RULES: ReadonlyArray<{ readonly rule: string; readonly re: RegExp; readonly scope?: RegExp }> = [
  { rule: "as-any", re: /\bas\s+any\b/ },
  { rule: "ts-ignore", re: /@ts-(ignore|expect-error|nocheck)/ },
  { rule: "non-null-assertion", re: /[A-Za-z_$)\]]!\s*(?:[.[(;,)\]}]|$)/ },
  { rule: "inline-object-cast", re: /\bas\s+\{/ },
  { rule: "double-cast", re: /\bas\s+unknown\s+as\b/ },
  { rule: "named-cast", re: /\bas\s+(?:new\s+)?[A-Z][A-Za-z0-9_]*/ },
  { rule: "function-cast", re: /\bas\s+\(/ },
  { rule: "trailing-cast", re: /\bas\s*$/ },
  { rule: "raw-cdp-call", re: /(?:session\(\)|\bsession)\.call(?:OnTarget|Browser)?\(/, scope: /^src\/domains\// },
  { rule: "raw-evaluate", re: /\.evaluateJs\(/, scope: /^src\/domains\// },
];

export type SourceFile = { readonly path: string; readonly text: string };

const normalise = (path: string): string => path.split("\\").join("/");

const key = (path: string, rule: string): string => `${normalise(path)}\u0000${rule}`;

const budgets = (exemptions: ReadonlyArray<Exemption>): Map<string, number> => {
  const out = new Map<string, number>();
  for (const e of exemptions) out.set(key(e.path, e.rule), (out.get(key(e.path, e.rule)) ?? 0) + e.count);
  return out;
};

const rawHits = (files: ReadonlyArray<SourceFile>): ReadonlyArray<Violation> => {
  const out: Violation[] = [];
  for (const file of files) {
    const path = normalise(file.path);
    for (const [i, line] of file.text.split("\n").entries()) {
      for (const { rule, re, scope } of RULES) {
        if (scope && !scope.test(path)) continue;
        if (re.test(line)) out.push({ path: file.path, line: i + 1, rule, text: line.trim() });
      }
    }
  }
  return out;
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
  readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const p = join(dir, name);
      return statSync(p).isDirectory() ? walk(p) : p.endsWith(".ts") ? [p] : [];
    });

const main = (): void => {
  const files = walk("src").map((path) => ({ path: normalise(path), text: readFileSync(path, "utf8") }));
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
