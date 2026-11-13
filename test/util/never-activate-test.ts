import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { Type } from "typebox";
import type { ExtensionAPI, ExtensionContext, ToolDefinition } from "@mariozechner/pi-coding-agent";
import { neverActivate, setNeverActivate, createInBackground } from "../../src/util/activation";
import { explainTimeoutUnderPolicy, foregroundRefusal, type ToolForeground } from "../../src/util/foreground";
import { defineBrowserTool, type ToolErr } from "../../src/util/tool";
import { ALL_TOOLS } from "../../src/registry";
import type { BrowserClient } from "../../src/client";
import { cdpError } from "../../src/cdp/errors";
import { type Result, err, ok } from "../../src/util/result";
import { createFakeClient } from "../domains/fake-client";
import { underNeverActivate } from "../helpers/never-activate";

const clientReporting = async (visibility: Result<unknown, ReturnType<typeof cdpError>>): Promise<{ client: BrowserClient; probes: () => number }> => {
  const fake = await createFakeClient({ evaluate: () => visibility });
  return { client: fake.client, probes: () => fake.evaluated.filter((e) => e === "document.visibilityState").length };
};

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

  test("targets are created in the background only under the policy", async () => {
    assert.deepEqual(createInBackground(), {});
    await underNeverActivate(() => {
      assert.deepEqual(createInBackground(), { background: true });
      return Promise.resolve();
    });
  });
});

describe("which tools need the foreground", () => {
  test("only the tools that send trusted pointer input declare a need", () => {
    const declared = Object.fromEntries(ALL_TOOLS.filter((t) => t.foreground !== undefined).map((t) => [t.name, t.foreground]));
    assert.deepEqual(declared, {
      browser_click: "raises",
      browser_drag_and_drop: "raises",
      browser_scroll: "rendered",
    });
  });
});

describe("foreground refusal", () => {
  test("with the policy off nothing is refused and the page is not even asked", async () => {
    const { client, probes } = await clientReporting(ok("hidden"));
    assert.equal(await foregroundRefusal("browser_click", "raises", client), undefined);
    assert.equal(await foregroundRefusal("browser_scroll", "rendered", client), undefined);
    assert.equal(probes(), 0);
  });

  test("a tool with no declared need is never refused", async () => {
    const { client, probes } = await clientReporting(ok("hidden"));
    await underNeverActivate(async () => {
      assert.equal(await foregroundRefusal("browser_snapshot", undefined, client), undefined);
    });
    assert.equal(probes(), 0);
  });

  test("a tool that raises the window is refused outright, with the way round it and the way out", async () => {
    const { client, probes } = await clientReporting(ok("visible"));
    const refusal = await underNeverActivate(() => foregroundRefusal("browser_click", "raises", client));
    assert.ok(refusal, "the tool was not refused");
    assert.equal(refusal.kind, "policy");
    assert.match(refusal.message, /^browser_click presses a real mouse button/);
    assert.match(refusal.message, /Nothing was sent to the page/);
    assert.match(refusal.message, /browser_execute_js/);
    assert.match(refusal.message, /turn background mode off with \/browser-background/);
    assert.equal(probes(), 0, "the verdict does not depend on the tab");
  });

  test("a tool that needs a rendered tab is refused on a hidden tab and allowed on a visible one", async () => {
    const hidden = await clientReporting(ok("hidden"));
    const visible = await clientReporting(ok("visible"));
    await underNeverActivate(async () => {
      const refusal = await foregroundRefusal("browser_scroll", "rendered", hidden.client);
      assert.ok(refusal, "the tool was not refused");
      assert.equal(refusal.kind, "policy");
      assert.match(refusal.message, /^browser_scroll needs this tab on screen/);
      assert.match(refusal.message, /window\.scrollBy/);
      assert.equal(await foregroundRefusal("browser_scroll", "rendered", visible.client), undefined);
    });
  });

  test("a page that cannot say whether it is visible is not refused on a guess", async () => {
    const silent = await clientReporting(err(cdpError("timeout", "dialog open")));
    await underNeverActivate(async () => {
      assert.equal(await foregroundRefusal("browser_scroll", "rendered", silent.client), undefined);
    });
  });
});

describe("timeouts under the policy", () => {
  const timeout: ToolErr = { kind: "timeout", message: "Timeout after 10000ms: Page.captureScreenshot" };

  test("a timeout on a background tab says why and what to do instead", async () => {
    const { client } = await clientReporting(ok("hidden"));
    const explained = await underNeverActivate(() => explainTimeoutUnderPolicy(timeout, client));
    assert.equal(explained.kind, "timeout");
    assert.match(explained.message, /^Timeout after 10000ms: Page\.captureScreenshot\. This tab is in the background/);
    assert.match(explained.message, /browser_snapshot or browser_read_page/);
  });

  test("a timeout on a visible tab, another error, or the policy being off is left exactly as it was", async () => {
    const hidden = await clientReporting(ok("hidden"));
    const visible = await clientReporting(ok("visible"));
    const other: ToolErr = { kind: "cdp_error", message: "boom" };
    assert.equal(await explainTimeoutUnderPolicy(timeout, hidden.client), timeout);
    await underNeverActivate(async () => {
      assert.equal(await explainTimeoutUnderPolicy(timeout, visible.client), timeout);
      assert.equal(await explainTimeoutUnderPolicy(other, hidden.client), other);
    });
  });
});

type Run = { readonly ran: number; readonly text: string; readonly rejected: boolean };

// Drives a tool the way pi does, through the registered execute(), which is where the refusal lives.
const execute = async (
  client: BrowserClient,
  foreground: ToolForeground | undefined,
  outcome: Result<{ text: string }, ToolErr> = ok({ text: "done" }),
): Promise<Run> => {
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
      return Promise.resolve(outcome);
    },
  });
  let registered: ToolDefinition | undefined;
  const sink = { registerTool: (td: ToolDefinition) => { registered = td; } };
  // eslint-disable-next-line @typescript-eslint/no-unsafe-type-assertion -- pi's registerTool is generic over the schema; a sink typed for one schema needs the same erasure pi itself does
  tool.register(sink as unknown as ExtensionAPI, client);
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

describe("the tool gate under the policy", () => {
  test("a refused tool never runs its handler, and reports a policy error rather than success", async () => {
    const { client } = await clientReporting(ok("visible"));
    const run = await underNeverActivate(() => execute(client, "raises"));
    assert.equal(run.ran, 0);
    assert.equal(run.rejected, true);
    assert.match(run.text, /^browser_probe failed \(policy\): browser_probe presses a real mouse button/);
  });

  test("a refusal releases the serialized lane, so the next tool is not left waiting", async () => {
    const { client } = await clientReporting(ok("visible"));
    await underNeverActivate(() => execute(client, "raises"));
    const next = await execute(client, undefined);
    assert.deepEqual(next, { ran: 1, text: "done", rejected: false });
  });

  test("the same tool runs normally with the policy off", async () => {
    const { client } = await clientReporting(ok("hidden"));
    assert.deepEqual(await execute(client, "raises"), { ran: 1, text: "done", rejected: false });
    assert.deepEqual(await execute(client, "rendered"), { ran: 1, text: "done", rejected: false });
  });

  test("a rendered-tab tool runs on a visible tab and is refused on a hidden one", async () => {
    const visible = await clientReporting(ok("visible"));
    const hidden = await clientReporting(ok("hidden"));
    await underNeverActivate(async () => {
      assert.equal((await execute(visible.client, "rendered")).ran, 1);
      const refused = await execute(hidden.client, "rendered");
      assert.equal(refused.ran, 0);
      assert.match(refused.text, /failed \(policy\): browser_probe needs this tab on screen/);
    });
  });

  test("a handler timeout on a background tab reaches the model with the explanation attached", async () => {
    const { client } = await clientReporting(ok("hidden"));
    const run = await underNeverActivate(() => execute(client, undefined, err({ kind: "timeout", message: "Timeout after 10000ms: Page.captureScreenshot" })));
    assert.equal(run.ran, 1);
    assert.match(run.text, /failed \(timeout\): Timeout after 10000ms: Page\.captureScreenshot\. This tab is in the background/);
  });
});
