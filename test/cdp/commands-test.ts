import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { COMMANDS, decodeResult } from "../../src/cdp/commands";

describe("cdp command table", () => {
  test("decodes a well-formed response", () => {
    const r = decodeResult("Target.attachToTarget", { sessionId: "s1" });
    assert.equal(r.success, true);
    if (r.success) assert.equal(r.data.sessionId, "s1");
  });

  test("rejects a response with a wrong field type", () => {
    const r = decodeResult("Browser.getWindowForTarget", { windowId: "not-a-number" });
    assert.equal(r.success, false);
    if (!r.success) {
      assert.equal(r.error.kind, "invalid_response");
      assert.equal(r.error.method, "Browser.getWindowForTarget");
      assert.match(r.error.message, /must be number/);
    }
  });

  test("rejects a response missing a required field", () => {
    const r = decodeResult("Target.attachToTarget", {});
    assert.equal(r.success, false);
  });

  test("rejects a non-object response", () => {
    const r = decodeResult("Target.attachToTarget", null);
    assert.equal(r.success, false);
  });

  test("every table entry has both params and result schemas", () => {
    for (const [method, spec] of Object.entries(COMMANDS)) {
      assert.ok(spec.params, `${method} missing params schema`);
      assert.ok(spec.result, `${method} missing result schema`);
      assert.ok(spec.validate, `${method} missing compiled validator`);
    }
  });

  test("an unknown method decodes to an error rather than throwing", () => {
    // Types prevent this, but a daemon could echo an unexpected method name.
    const r = decodeResult("Nope.method" as "Page.enable", {});
    assert.equal(r.success, false);
  });
});

describe("Accessibility.getFullAXTree schema", () => {
  test("accepts a realistic Chrome AX node with unmodelled extra fields", () => {
    const r = decodeResult("Accessibility.getFullAXTree", {
      nodes: [
        {
          nodeId: "1",
          ignored: false,
          role: { type: "role", value: "RootWebArea" },
          chromeRole: { type: "internalRole", value: 144 },
          name: { type: "computedString", value: "Example", sources: [{ type: "relatedElement" }] },
          properties: [
            { name: "focusable", value: { type: "booleanOrUndefined", value: true } },
            { name: "level", value: { type: "integer", value: 2 } },
          ],
          childIds: ["2", "3"],
          backendDOMNodeId: 7,
          frameId: "F1",
        },
        { nodeId: "2", parentId: "1", ignored: true, ignoredReasons: [{ name: "notRendered" }] },
      ],
    });
    assert.equal(r.success, true);
    if (r.success) {
      assert.equal(r.data.nodes.length, 2);
      assert.equal(r.data.nodes[0]?.role?.value, "RootWebArea");
      assert.equal(r.data.nodes[0]?.backendDOMNodeId, 7);
      assert.deepEqual(r.data.nodes[0]?.childIds, ["2", "3"]);
    }
  });

  test("accepts an empty node list", () => {
    const r = decodeResult("Accessibility.getFullAXTree", { nodes: [] });
    assert.equal(r.success, true);
  });

  test("rejects a node whose nodeId is not a string", () => {
    const r = decodeResult("Accessibility.getFullAXTree", { nodes: [{ nodeId: 5 }] });
    assert.equal(r.success, false);
    if (!r.success) assert.equal(r.error.kind, "invalid_response");
  });

  test("rejects childIds that are not strings", () => {
    const r = decodeResult("Accessibility.getFullAXTree", { nodes: [{ nodeId: "1", childIds: [2] }] });
    assert.equal(r.success, false);
  });

  test("rejects a missing nodes array", () => {
    const r = decodeResult("Accessibility.getFullAXTree", {});
    assert.equal(r.success, false);
  });

  test("keeps an AxValue's value untyped so any Chrome value type decodes", () => {
    const r = decodeResult("Accessibility.getFullAXTree", {
      nodes: [{ nodeId: "1", value: { type: "number", value: 42 } }, { nodeId: "2", name: { type: "x", value: null } }],
    });
    assert.equal(r.success, true);
  });
});
