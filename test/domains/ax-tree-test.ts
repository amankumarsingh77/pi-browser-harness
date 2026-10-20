import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { createFakeClient } from "./fake-client";
import {
  INTERACTIVE_ROLES,
  type RawAxNode,
  type SlimNode,
  VALUE_ROLES,
  buildTree,
  collectInteractiveTargets,
  countNodes,
  liveValue,
  stripInternals,
} from "../../src/domains/ax-tree";
import { ok } from "../../src/util/result";

const ax = (nodeId: string, role: string, name: string, extra: Partial<RawAxNode> = {}): RawAxNode => ({
  nodeId,
  role: { value: role },
  name: { value: name },
  ...extra,
});

const prop = (name: string, value: unknown) => ({ name, value: { value } });

// A small page: a root with a heading, a form whose wrapper Chrome ignores, and a footer link.
//   RootWebArea
//     heading "Welcome" (level 2)
//     generic (ignored)
//       textbox "Email" value "a@b" (focused, required)   backend 101
//       button "Send" (disabled)                            backend 102
//     link "Help"                                            backend 103
const PAGE: ReadonlyArray<RawAxNode> = [
  ax("1", "RootWebArea", "Home", { childIds: ["2", "3", "6"] }),
  ax("2", "heading", "Welcome", { parentId: "1", properties: [prop("level", 2)] }),
  ax("3", "generic", "", { parentId: "1", ignored: true, childIds: ["4", "5"] }),
  ax("4", "textbox", "Email", {
    parentId: "3", backendDOMNodeId: 101, value: { value: "a@b" }, description: { value: "Your address" },
    properties: [prop("focused", true), prop("required", true), prop("invalid", true), prop("editable", "plaintext")],
  }),
  ax("5", "button", "Send", { parentId: "3", backendDOMNodeId: 102, properties: [prop("disabled", true), prop("focused", false)] }),
  ax("6", "link", "Help", { parentId: "1", backendDOMNodeId: 103 }),
];

const outline = (nodes: ReadonlyArray<SlimNode>, depth = 0): string[] =>
  nodes.flatMap((n) => [`${"  ".repeat(depth)}${n.role}${n.name !== undefined ? ` "${n.name}"` : ""}`, ...outline(n.children, depth + 1)]);

describe("buildTree", () => {
  test("shapes the flat node list into a tree, hoisting the children of ignored wrappers", () => {
    const tree = buildTree(PAGE, { interestingOnly: true, maxNodes: 100 });
    assert.deepEqual(outline(tree), [
      'RootWebArea "Home"',
      '  heading "Welcome"',
      '  textbox "Email"',
      '  button "Send"',
      '  link "Help"',
    ]);
  });

  test("carries name, value, description, the state flags and the backend id", () => {
    const tree = buildTree(PAGE, { interestingOnly: true, maxNodes: 100 });
    const email = tree[0]?.children[1];
    assert.deepEqual(email, {
      role: "textbox", name: "Email", value: "a@b", description: "Your address", state: "focused, required", children: [], _backendId: 101,
    });
    const send = tree[0]?.children[2];
    assert.equal(send?.state, "disabled");
    assert.equal(send._backendId, 102);
    const heading = tree[0]?.children[0];
    assert.equal(heading?.state, "level 2");
    assert.equal(heading._backendId, undefined);
  });

  test("an unflagged node has no state, name or value keys at all", () => {
    const tree = buildTree([ax("1", "RootWebArea", "", { properties: [prop("focused", false), prop("hidden", true)] })], { interestingOnly: true, maxNodes: 10 });
    assert.deepEqual(tree, [{ role: "RootWebArea", children: [] }]);
  });

  test("with interestingOnly off, ignored nodes stay in the tree as their own level", () => {
    const tree = buildTree(PAGE, { interestingOnly: false, maxNodes: 100 });
    assert.deepEqual(outline(tree), [
      'RootWebArea "Home"',
      '  heading "Welcome"',
      "  generic",
      '    textbox "Email"',
      '    button "Send"',
      '  link "Help"',
    ]);
  });

  test("a numeric value is stringified and a missing role is unknown", () => {
    const tree = buildTree([{ nodeId: "1", value: { value: 42 } }], { interestingOnly: true, maxNodes: 10 });
    assert.deepEqual(tree, [{ role: "unknown", value: "42", children: [] }]);
  });

  test("a node whose parent is not in the list is a root, and unknown child ids are skipped", () => {
    const tree = buildTree(
      [ax("1", "RootWebArea", "", { childIds: ["2", "missing"] }), ax("2", "button", "A", { parentId: "1" }), ax("9", "button", "Orphan", { parentId: "gone" })],
      { interestingOnly: true, maxNodes: 10 },
    );
    assert.deepEqual(outline(tree), ['RootWebArea', '  button "A"', 'button "Orphan"']);
  });

  test("an ignored root whose children are all ignored yields nothing", () => {
    const tree = buildTree(
      [ax("1", "generic", "", { ignored: true, childIds: ["2"] }), ax("2", "generic", "", { parentId: "1", ignored: true })],
      { interestingOnly: true, maxNodes: 10 },
    );
    assert.deepEqual(tree, []);
  });

  test("ignored roots hoist their children to the top level", () => {
    const tree = buildTree(
      [ax("1", "generic", "", { ignored: true, childIds: ["2", "3"] }), ax("2", "button", "A", { parentId: "1" }), ax("3", "button", "B", { parentId: "1" })],
      { interestingOnly: true, maxNodes: 10 },
    );
    assert.deepEqual(outline(tree), ['button "A"', 'button "B"']);
  });

  test("maxNodes caps the number of kept nodes in document order; ignored nodes do not count", () => {
    const tree = buildTree(PAGE, { interestingOnly: true, maxNodes: 3 });
    assert.deepEqual(outline(tree), ['RootWebArea "Home"', '  heading "Welcome"', '  textbox "Email"']);
    assert.equal(countNodes(tree), 3);
    const none = buildTree(PAGE, { interestingOnly: true, maxNodes: 0 });
    assert.deepEqual(none, []);
  });

  test("does not mutate the raw nodes", () => {
    const raw = [ax("1", "RootWebArea", "", { childIds: ["2"] }), ax("2", "button", "A", { parentId: "1", backendDOMNodeId: 7 })];
    const snapshot = JSON.stringify(raw);
    buildTree(raw, { interestingOnly: true, maxNodes: 10 });
    assert.equal(JSON.stringify(raw), snapshot);
  });
});

describe("countNodes, stripInternals and collectInteractiveTargets", () => {
  const tree = buildTree(PAGE, { interestingOnly: true, maxNodes: 100 });

  test("countNodes counts every node in the tree", () => {
    assert.equal(countNodes(tree), 5);
    assert.equal(countNodes([]), 0);
  });

  test("stripInternals removes backend ids at every depth and leaves the input untouched", () => {
    const stripped = stripInternals(tree);
    const hasBackendId = (ns: ReadonlyArray<SlimNode>): boolean => ns.some((n) => n._backendId !== undefined || hasBackendId(n.children));
    assert.equal(hasBackendId(stripped), false);
    assert.equal(hasBackendId(tree), true);
    assert.deepEqual(outline(stripped), outline(tree));
    assert.equal(stripped[0]?.children[1]?.value, "a@b");
  });

  test("collectInteractiveTargets lists interactive nodes with a backend id, in document order", () => {
    const targets = collectInteractiveTargets(tree);
    assert.deepEqual(targets.map((t) => [t.node.role, t.node.name, t.backendId]), [
      ["textbox", "Email", 101],
      ["button", "Send", 102],
      ["link", "Help", 103],
    ]);
    assert.equal(targets[0]?.node, tree[0]?.children[1], "the target points at the live node, so a ref can be written onto it");
  });

  test("an interactive node without a backend id is not a target", () => {
    const targets = collectInteractiveTargets(buildTree([ax("1", "button", "Ghost")], { interestingOnly: true, maxNodes: 10 }));
    assert.deepEqual(targets, []);
  });

  test("the interactive and value role sets are the ones refs and live values rely on", () => {
    for (const role of ["button", "link", "textbox", "checkbox", "radio", "combobox", "menuitem", "tab", "switch", "slider", "searchbox", "spinbutton"]) {
      assert.ok(INTERACTIVE_ROLES.has(role), role);
    }
    assert.equal(INTERACTIVE_ROLES.has("heading"), false);
    for (const role of VALUE_ROLES) assert.ok(role === "textbox" || role === "searchbox" || role === "spinbutton" || role === "combobox" || role === "checkbox" || role === "radio" || role === "switch" || role === "slider");
    assert.equal(VALUE_ROLES.has("button"), false);
  });
});

describe("liveValue", () => {
  test("resolves the node and calls the page function on it by value", async () => {
    const fake = await createFakeClient({
      canned: {
        "DOM.resolveNode": ok({ object: { type: "object", objectId: "obj-9" } }),
        "Runtime.callFunctionOn": ok({ result: { type: "string", value: "typed text" } }),
      },
    });
    assert.equal(await liveValue(fake.client, 101), "typed text");
    assert.deepEqual(fake.callsTo("DOM.resolveNode")[0]?.params, { backendNodeId: 101 });
    const call = fake.callsTo("Runtime.callFunctionOn")[0];
    assert.equal(call?.params["objectId"], "obj-9");
    assert.equal(call.params["returnByValue"], true);
    assert.match(String(call.params["functionDeclaration"]), /^function/);
  });

  test("a non-string page value is undefined", async () => {
    const fake = await createFakeClient({
      canned: {
        "DOM.resolveNode": ok({ object: { type: "object", objectId: "obj-9" } }),
        "Runtime.callFunctionOn": ok({ result: { type: "object", subtype: "null", value: null } }),
      },
    });
    assert.equal(await liveValue(fake.client, 101), undefined);
  });

  test("a node that resolves without an object id is undefined and never called", async () => {
    const fake = await createFakeClient({ canned: { "DOM.resolveNode": ok({ object: { type: "undefined" } }) } });
    assert.equal(await liveValue(fake.client, 101), undefined);
    assert.equal(fake.callsTo("Runtime.callFunctionOn").length, 0);
  });

  test("a CDP failure on either call is undefined, not an error", async () => {
    const resolveFails = await createFakeClient({
      canned: { "DOM.resolveNode": { success: false, error: { kind: "remote_error", message: "No node" } } },
    });
    assert.equal(await liveValue(resolveFails.client, 101), undefined);
    const callFails = await createFakeClient({
      canned: {
        "DOM.resolveNode": ok({ object: { type: "object", objectId: "obj-9" } }),
        "Runtime.callFunctionOn": { success: false, error: { kind: "timeout", message: "slow" } },
      },
    });
    assert.equal(await liveValue(callFails.client, 101), undefined);
  });
});
