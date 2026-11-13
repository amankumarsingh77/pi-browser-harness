import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { neverActivate, setNeverActivate, createInBackground } from "../../src/util/activation";
import { showTabIfHidden, type ToolForeground } from "../../src/util/foreground";
import { defineBrowserTool } from "../../src/util/tool";
import { ALL_TOOLS } from "../../src/registry";
import { cdpError, type CdpError } from "../../src/cdp/errors";
import { type Result, err, ok } from "../../src/util/result";
import { type Canned, type FakeClient, createFakeClient } from "../domains/fake-client";
import { underNeverActivate } from "../helpers/never-activate";

const tab = (visibility: Result<unknown, CdpError>, canned: Canned = {}): Promise<FakeClient> =>
  createFakeClient({ evaluate: () => visibility, canned });

const broughtForward = (fake: FakeClient): number => fake.callsTo("Page.bringToFront").length;

describe("background mode switch", () => {
  test("it is off until it is set, and no environment variable turns it on", () => {
    const saved = process.env["BH_NEVER_ACTIVATE"];
    process.env["BH_NEVER_ACTIVATE"] = "1";
    try {
      assert.equal(neverActivate(), false);
      setNeverActivate(true);
      assert.equal(neverActivate(), true);
    } finally {
      setNeverActivate(false);
      if (saved === undefined) Reflect.deleteProperty(process.env, "BH_NEVER_ACTIVATE");
      else process.env["BH_NEVER_ACTIVATE"] = saved;
    }
    assert.equal(neverActivate(), false);
  });

  test("targets are created in the background only in background mode", async () => {
    assert.deepEqual(createInBackground(), {});
    await underNeverActivate(() => {
      assert.deepEqual(createInBackground(), { background: true });
      return Promise.resolve();
    });
  });
});

describe("which tools need the tab on screen", () => {
  test("only the tools that send trusted pointer input declare it", () => {
    const declared = Object.fromEntries(ALL_TOOLS.filter((t) => t.foreground !== undefined).map((t) => [t.name, t.foreground]));
    assert.deepEqual(declared, {
      browser_click: "raises",
      browser_drag_and_drop: "raises",
      browser_scroll: "rendered",
    });
  });
});

describe("showing a hidden tab", () => {
  test("with background mode off nothing is asked of the page and nothing is brought forward", async () => {
    const fake = await tab(ok("hidden"));
    assert.deepEqual(await showTabIfHidden(fake.client), ok(undefined));
    assert.equal(fake.evaluated.length, 0);
    assert.equal(broughtForward(fake), 0);
  });

  test("in background mode a hidden tab is brought forward", async () => {
    const fake = await tab(ok("hidden"));
    assert.deepEqual(await underNeverActivate(() => showTabIfHidden(fake.client)), ok(undefined));
    assert.equal(broughtForward(fake), 1);
  });

  test("in background mode a visible tab is left where it is", async () => {
    const fake = await tab(ok("visible"));
    assert.deepEqual(await underNeverActivate(() => showTabIfHidden(fake.client)), ok(undefined));
    assert.equal(broughtForward(fake), 0);
  });

  test("a tab that cannot say whether it is visible is brought forward, as it would be with the mode off", async () => {
    const fake = await tab(err(cdpError("timeout", "dialog open")));
    await underNeverActivate(() => showTabIfHidden(fake.client));
    assert.equal(broughtForward(fake), 1);
  });

  test("a failure to bring the tab forward is returned", async () => {
    const fake = await tab(ok("hidden"), { "Page.bringToFront": err(cdpError("remote_error", "no page")) });
    const r = await underNeverActivate(() => showTabIfHidden(fake.client));
    assert.equal(r.success, false);
  });
});

type Run = { readonly ran: number; readonly text: string; readonly rejected: boolean };

// Drives a tool the way pi does, through the registered execute(), which is where the tab is shown.
const execute = async (fake: FakeClient, foreground: ToolForeground | undefined): Promise<Run> => {
  let ran = 0;
  const tool = defineBrowserTool({
    name: "browser_probe",
    label: "Probe",
    description: "probe",
    promptSnippet: "probe",
    promptGuidelines: [],
    parameters: Type.Object({}),
    concurrency: "serialized",
    ensureAlive: false,
    ...(foreground !== undefined ? { foreground } : {}),
    handler: () => {
      ran++;
      return Promise.resolve(ok({ text: "done" }));
    },
  });
  let registered: ToolDefinition | undefined;
  const sink = { registerTool: (td: ToolDefinition) => { registered = td; } };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- pi's registerTool is generic over the schema; a sink typed for one schema needs the same erasure pi itself does
  tool.register(sink as unknown as ExtensionAPI, fake.client);
  assert.ok(registered, "tool was not registered");
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- the probe handler never reads its context
  const extensionCtx = undefined as unknown as ExtensionContext;
  try {
    const result = await registered.execute("id", {}, undefined, undefined, extensionCtx);
    const first = result.content[0];
    return { ran, text: first?.type === "text" ? first.text : "", rejected: false };
  } catch (e) {
    return { ran, text: e instanceof Error ? e.message : String(e), rejected: true };
  }
};

const DONE: Run = { ran: 1, text: "done", rejected: false };

describe("the tool gate in background mode", () => {
  test("no tool is ever refused: every kind runs, on a hidden tab and on a visible one", async () => {
    await underNeverActivate(async () => {
      for (const visibility of ["hidden", "visible"]) {
        for (const foreground of ["raises", "rendered", undefined] as const) {
          assert.deepEqual(await execute(await tab(ok(visibility)), foreground), DONE, `${String(foreground)} on a ${visibility} tab`);
        }
      }
    });
  });

  test("a tool that needs the tab on screen brings a hidden tab forward before it runs", async () => {
    const fake = await tab(ok("hidden"));
    await underNeverActivate(() => execute(fake, "rendered"));
    assert.equal(broughtForward(fake), 1);
  });

  test("the same tool leaves a visible tab where it is", async () => {
    const fake = await tab(ok("visible"));
    await underNeverActivate(() => execute(fake, "raises"));
    assert.equal(broughtForward(fake), 0);
  });

  test("a tool that does not need the screen never brings the tab forward", async () => {
    const fake = await tab(ok("hidden"));
    await underNeverActivate(() => execute(fake, undefined));
    assert.equal(broughtForward(fake), 0);
    assert.equal(fake.evaluated.length, 0, "the page is not even asked");
  });

  test("with background mode off the gate does nothing extra", async () => {
    const fake = await tab(ok("hidden"));
    assert.deepEqual(await execute(fake, "rendered"), DONE);
    assert.equal(broughtForward(fake), 0);
    assert.equal(fake.evaluated.length, 0);
  });

  test("a failure to bring the tab forward fails the call and frees the serialized lane", async () => {
    const fake = await tab(ok("hidden"), { "Page.bringToFront": err(cdpError("remote_error", "no page")) });
    const run = await underNeverActivate(() => execute(fake, "rendered"));
    assert.equal(run.ran, 0);
    assert.match(run.text, /^browser_probe failed \(cdp_error\): no page/);
    assert.deepEqual(await execute(fake, undefined), DONE);
  });
});
