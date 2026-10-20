import { test, describe, before } from "node:test";
import assert from "node:assert/strict";
import { installTheme, renderedText } from "./client-overrides";
import { renderExpandableText } from "../../src/domains/render";

const body = (n: number): string => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

describe("renderExpandableText", () => {
  before(() => {
    installTheme();
  });

  test("collapsed shows the summary, the first six lines and the count of hidden lines", () => {
    const text = renderedText(renderExpandableText({ summary: "Nine lines", body: body(9) }, false));
    assert.match(text, /Nine lines/);
    assert.match(text, /line 6/);
    assert.doesNotMatch(text, /line 7/);
    assert.match(text, /… 3 more lines/);
    assert.match(text, /to expand/);
    assert.doesNotMatch(text, /to collapse/);
  });

  test("collapsed with six lines or fewer shows everything and no hidden-line count", () => {
    const text = renderedText(renderExpandableText({ summary: "Short", body: body(6) }, false));
    assert.match(text, /line 6/);
    assert.doesNotMatch(text, /more lines/);
  });

  test("expanded shows the whole body and the collapse hint", () => {
    const text = renderedText(renderExpandableText({ summary: "Nine lines", body: body(9) }, true));
    assert.match(text, /line 9/);
    assert.doesNotMatch(text, /more lines/);
    assert.match(text, /to collapse/);
    assert.doesNotMatch(text, /Full output at/);
  });

  test("expanded names the full-output file when the body was truncated to one", () => {
    const text = renderedText(
      renderExpandableText({ summary: "S", body: "b", fullOutputPath: "/tmp/pi-bh/output.txt" }, true),
    );
    assert.match(text, /Full output at .*\/tmp\/pi-bh\/output\.txt/);
    assert.match(text, /to collapse/);
  });

  test("collapsed does not mention the full-output file", () => {
    const text = renderedText(
      renderExpandableText({ summary: "S", body: "b", fullOutputPath: "/tmp/pi-bh/output.txt" }, false),
    );
    assert.doesNotMatch(text, /output\.txt/);
  });

  test("an empty body still renders the summary", () => {
    const text = renderedText(renderExpandableText({ summary: "Nothing", body: "" }, false));
    assert.match(text, /Nothing/);
  });
});
