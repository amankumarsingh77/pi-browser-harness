import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { checkSource, unusedExemptions, type Exemption } from "../../scripts/check-boundaries";

const noExemptions: ReadonlyArray<Exemption> = [];

describe("boundary check", () => {
  test("flags as any", () => {
    const v = checkSource([{ path: "a.ts", text: "const x = y as any;" }], noExemptions);
    assert.equal(v.length, 1);
    assert.equal(v[0]?.rule, "as-any");
  });

  test("flags as any[]", () => {
    const v = checkSource([{ path: "a.ts", text: "const x = y as any[];" }], noExemptions);
    assert.equal(v.length, 1);
    assert.equal(v[0]?.rule, "as-any");
  });

  test("flags a ts-ignore", () => {
    const v = checkSource([{ path: "a.ts", text: "// @ts-ignore\nconst x = 1;" }], noExemptions);
    assert.equal(v.length, 1);
    assert.equal(v[0]?.rule, "ts-ignore");
  });

  test("flags ts-expect-error and ts-nocheck", () => {
    const expectError = checkSource([{ path: "a.ts", text: "// @ts-expect-error" }], noExemptions);
    const noCheck = checkSource([{ path: "a.ts", text: "// @ts-nocheck" }], noExemptions);
    assert.equal(expectError.length, 1);
    assert.equal(noCheck.length, 1);
  });

  test("flags a non-null assertion before a property access", () => {
    const v = checkSource([{ path: "a.ts", text: "const w = data.model!.width;" }], noExemptions);
    assert.equal(v.length, 1);
    assert.equal(v[0]?.rule, "non-null-assertion");
  });

  test("flags a non-null assertion with no property access after it", () => {
    const forms = ["const a = b!;", "f(g!);", "const c = arr[0]!;", "const d = [x!, y];", "const e = obj\n  .a!\n  .b;"];
    for (const text of forms) {
      const v = checkSource([{ path: "a.ts", text }], noExemptions);
      assert.equal(v.length, 1, text);
      assert.equal(v[0]?.rule, "non-null-assertion", text);
    }
  });

  test("does not flag strict inequality, spaced or unspaced", () => {
    for (const text of ["if (a !== b.c) return;", "if (a!==b.c) return;", "if (a != b.c) return;", "if (a!=b.c) return;"]) {
      assert.equal(checkSource([{ path: "a.ts", text }], noExemptions).length, 0, text);
    }
  });

  test("does not flag boolean negation", () => {
    for (const text of ["if (!ok.value) return;", "const n = a && !b.c;", "return !this.done;", "const m = [!x.y];"]) {
      assert.equal(checkSource([{ path: "a.ts", text }], noExemptions).length, 0, text);
    }
  });

  test("does not flag an exclamation mark in prose", () => {
    const text = 'description: "Done! Use browser_snapshot as the default. Options: any of these."';
    assert.equal(checkSource([{ path: "a.ts", text }], noExemptions).length, 0);
  });

  test("flags an inline object cast", () => {
    const v = checkSource([{ path: "a.ts", text: "const d = r.data as { sessionId: string };" }], noExemptions);
    assert.equal(v.length, 1);
    assert.equal(v[0]?.rule, "inline-object-cast");
  });

  test("flags a double cast", () => {
    const v = checkSource([{ path: "a.ts", text: "const d = r as unknown as Session;" }], noExemptions);
    assert.equal(v.some((x) => x.rule === "double-cast"), true);
  });

  test("allows as const", () => {
    assert.equal(checkSource([{ path: "a.ts", text: "const x = [1] as const;" }], noExemptions).length, 0);
  });

  test("allows a cast to a named type", () => {
    assert.equal(checkSource([{ path: "a.ts", text: "return ok(raw as ResultOf<M>);" }], noExemptions).length, 0);
  });

  test("reports the 1-indexed line number and the trimmed text", () => {
    const v = checkSource([{ path: "a.ts", text: "const a = 1;\n  const b = c as any;" }], noExemptions);
    assert.equal(v[0]?.line, 2);
    assert.equal(v[0]?.text, "const b = c as any;");
    assert.equal(v[0]?.path, "a.ts");
  });

  test("scans every file it is given", () => {
    const v = checkSource(
      [
        { path: "a.ts", text: "const x = y as any;" },
        { path: "b.ts", text: "const z = w as any;" },
      ],
      noExemptions,
    );
    assert.deepEqual(
      v.map((x) => x.path),
      ["a.ts", "b.ts"],
    );
  });
});

describe("boundary check exemptions", () => {
  const exemptions: ReadonlyArray<Exemption> = [
    { path: "a.ts", rule: "inline-object-cast", count: 1, reason: "narrows an untyped dynamic import" },
  ];

  test("permits up to count violations for the exempted path and rule", () => {
    const v = checkSource([{ path: "a.ts", text: "const m = mod as { default?: unknown };" }], exemptions);
    assert.equal(v.length, 0);
  });

  test("reports the count+1-th violation so new casts cannot hide behind an exemption", () => {
    const text = "const m = mod as { default?: unknown };\nconst n = other as { x?: unknown };";
    const v = checkSource([{ path: "a.ts", text }], exemptions);
    assert.equal(v.length, 1);
    assert.equal(v[0]?.line, 2);
    assert.equal(v[0]?.rule, "inline-object-cast");
  });

  test("does not exempt a different rule in the same file", () => {
    const v = checkSource([{ path: "a.ts", text: "const x = y as any;" }], exemptions);
    assert.equal(v.length, 1);
    assert.equal(v[0]?.rule, "as-any");
  });

  test("does not exempt the same rule in a different file", () => {
    const v = checkSource([{ path: "b.ts", text: "const m = mod as { default?: unknown };" }], exemptions);
    assert.equal(v.length, 1);
    assert.equal(v[0]?.path, "b.ts");
  });

  test("counts exempted violations per file, not across all files", () => {
    const wide: ReadonlyArray<Exemption> = [
      { path: "a.ts", rule: "as-any", count: 1, reason: "one" },
      { path: "b.ts", rule: "as-any", count: 1, reason: "two" },
    ];
    const v = checkSource(
      [
        { path: "a.ts", text: "const x = y as any;" },
        { path: "b.ts", text: "const z = w as any;" },
      ],
      wide,
    );
    assert.equal(v.length, 0);
  });

  test("normalises windows path separators before matching", () => {
    const v = checkSource([{ path: "src\\util\\a.ts", text: "const x = y as any;" }], [
      { path: "src/util/a.ts", rule: "as-any", count: 1, reason: "platform independent" },
    ]);
    assert.equal(v.length, 0);
  });

  test("unusedExemptions names exemptions no longer earning their keep", () => {
    const stale = unusedExemptions([{ path: "a.ts", text: "const x = 1;" }], exemptions);
    assert.deepEqual(
      stale.map((e) => e.rule),
      ["inline-object-cast"],
    );
  });

  test("unusedExemptions is empty when every exemption is consumed", () => {
    const used = unusedExemptions([{ path: "a.ts", text: "const m = mod as { default?: unknown };" }], exemptions);
    assert.deepEqual(used, []);
  });
});
