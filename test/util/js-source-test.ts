import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { runInNewContext } from "node:vm";
import { pageExpression } from "../../src/util/js-source";

// Evaluates the prepared source the way Runtime.evaluate with awaitPromise does: a returned promise is awaited.
const valueOf = async (src: string): Promise<unknown> => {
  const out: unknown = runInNewContext(pageExpression(src), { document: { title: "Reports" } });
  return await out;
};

describe("pageExpression", () => {
  test("a plain expression is sent unchanged", () => {
    assert.equal(pageExpression("document.title"), "document.title");
  });

  test("a leading return is wrapped and yields its value", async () => {
    assert.equal(await valueOf("return document.title"), "Reports");
  });

  test("statements before a top-level return are wrapped and yield the returned value", async () => {
    assert.equal(await valueOf("const t = document.title; return t.toUpperCase()"), "REPORTS");
  });

  test("returns inside if/else blocks at top level are wrapped", async () => {
    assert.equal(await valueOf("if (document.title === 'Reports') { return 1 } else { return 2 }"), 1);
  });

  test("a return only inside a nested function leaves the source unchanged", () => {
    const src = "[1, 2].map((x) => { return x * 2 })";
    assert.equal(pageExpression(src), src);
  });

  test("a body ending in a line comment still closes its wrapper", async () => {
    assert.equal(await valueOf("const t = document.title\nreturn t // the title"), "Reports");
  });

  test("a top-level await with a return is wrapped in an async body", async () => {
    assert.equal(await valueOf("const t = await Promise.resolve(document.title); return t"), "Reports");
  });

  test("source that does not parse is sent unchanged so the page reports the error", () => {
    assert.equal(pageExpression("return (("), "return ((");
  });
});
