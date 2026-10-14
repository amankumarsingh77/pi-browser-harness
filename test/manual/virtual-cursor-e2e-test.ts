import { createBrowserClient } from "../../src/client";
import { createVirtualCursorController } from "../../src/cursor/controller";
import { createDaemonTransport } from "../../src/daemon/transport";
import { clickTool } from "../../src/domains/click";
import { dragAndDropTool } from "../../src/domains/drag";
import { screenshotTool } from "../../src/domains/screenshot";
import { scrollTool } from "../../src/domains/scroll";
import { snapshotTool } from "../../src/domains/snapshot";

let passed = 0;
let failed = 0;

const check = (condition: boolean, label: string): void => {
  if (condition) {
    passed++;
    console.log(`  PASS ${label}`);
  } else {
    failed++;
    console.error(`  FAIL ${label}`);
  }
};

const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const FIXTURE = `
<!doctype html>
<style>
  #move { position:absolute; left:40px; top:40px; box-sizing:border-box; width:120px; height:48px; padding:0; border:0 }
  #double { position:absolute; left:40px; top:130px; width:120px; height:48px }
  #context { position:absolute; left:220px; top:130px; width:120px; height:48px }
  #source, #target { position:absolute; top:220px; width:100px; height:60px; border:1px solid }
  #source { left:40px } #target { left:300px }
  #scroll { position:absolute; left:40px; top:340px; width:320px; height:180px; overflow:auto; border:1px solid }
  #scroll-content { height:700px; width:100% }
  dialog { position:fixed; left:120px; top:340px; width:220px; height:120px; margin:0 }
</style>
<button id="move">moves after frame</button>
<button id="double">double click</button>
<button id="context">context menu</button>
<div id="source" draggable="true">drag source</div>
<div id="target">drop target</div>
<div id="scroll"><div id="scroll-content">nested scroll</div></div>
<dialog id="cover">Top Layer cover</dialog>
<script>
  window.counts = { click: 0, double: 0, context: 0, drop: 0, wheel: 0 };
  window.eventLog = [];
  const log = (entry) => window.eventLog.push(entry);
  document.getElementById("move").addEventListener("click", () => window.counts.click++);
  document.getElementById("double").addEventListener("dblclick", () => window.counts.double++);
  document.getElementById("context").addEventListener("contextmenu", (event) => {
    event.preventDefault();
    window.counts.context++;
  });
  document.getElementById("target").addEventListener("dragover", (event) => event.preventDefault());
  document.getElementById("target").addEventListener("drop", (event) => {
    event.preventDefault();
    window.counts.drop++;
  });
  document.getElementById("scroll").addEventListener("wheel", () => window.counts.wheel++);
  document.addEventListener("toggle", (event) => log("toggle:" + event.target.tagName), true);
  setTimeout(() => requestAnimationFrame(() => {
    document.getElementById("move").style.left = "250px";
  }), 150);
</script>`;

const fixtureUrl = `data:text/html,${encodeURIComponent(FIXTURE)}`;

const contextFor = (client: any, cursor: any): any => ({
  client,
  cursor,
  signal: undefined,
  onUpdate: () => {},
  extensionCtx: { cwd: process.cwd() },
});

const evaluate = async (client: any, expression: string): Promise<unknown> => {
  const result = await client.evaluateJs(expression);
  return result.success ? result.data : undefined;
};

const publishRef = async (client: any, name: string): Promise<string | undefined> => {
  const ax = await client.session().call("Accessibility.getFullAXTree", {});
  if (!ax.success) return undefined;
  const node = ax.data.nodes.find((candidate: any) =>
    candidate.name?.value === name && typeof candidate.backendDOMNodeId === "number",
  );
  if (node?.backendDOMNodeId === undefined) return undefined;
  client.session().setRefMap(new Map([["e1", node.backendDOMNodeId]]), new Map([["e1", `|${name}||`]]));
  return "e1";
};

const cursorSnapshot = (client: any): Promise<Record<string, unknown> | undefined> =>
  evaluate(client, "globalThis[Symbol.for('pi-browser-harness.cursor.v1')].snapshot()") as Promise<Record<string, unknown> | undefined>;

async function main(): Promise<void> {
  const transport = createDaemonTransport("pi-virtual-cursor-e2e-test");
  const client = createBrowserClient({ namespace: "pi-virtual-cursor-e2e-test", transport });
  const cursor = createVirtualCursorController(client, {});
  const context = contextFor(client, cursor);
  let tabId: string | undefined;

  try {
    const started = await client.start();
    if (!started.success) {
      console.error(`NEEDS_CONTEXT: Chrome remote debugging is unavailable: ${started.error.message}`);
      process.exitCode = 2;
      return;
    }

    const tab = await client.newTab(fixtureUrl);
    check(tab.success, `opened owned fixture tab${tab.success ? "" : `: ${tab.error.message}`}`);
    if (!tab.success) return;
    tabId = tab.data;

    await wait(40);
    const movingRef = await publishRef(client, "moves after frame");
    check(movingRef !== undefined, "published moving button ref before its animation-frame move");
    await wait(220);
    const movedClick = await clickTool.handler({ ref: movingRef! }, context);
    check(movedClick.success, "real click handler revalidates moving button");
    check((await evaluate(client, "window.counts.click")) === 1, "moving button receives revalidated click");

    const first = await cursorSnapshot(client);
    check(first?.["connected"] === true && first["hostCount"] === 1, "one connected cursor host exists");
    check(first?.["x"] === 310 && first["y"] === 64, "cursor reports corrected moving-button coordinates");
    check(first?.["pressed"] === false && first["pointerEvents"] === "none", "cursor is released and cannot intercept pointer events");
    check((await evaluate(client, "document.activeElement.id")) === "move", "overlay does not take click focus");

    const reloaded = await client.session().call("Page.reload", {});
    check(reloaded.success, "reloaded the fixture");
    await wait(40);
    check(
      (await evaluate(client, "Boolean(globalThis[Symbol.for('pi-browser-harness.cursor.v1')])")) === false,
      "reload removes the old overlay before a new action",
    );
    const reloadedRef = await publishRef(client, "moves after frame");
    check(reloadedRef !== undefined, "published moving button ref after reload");
    await wait(220);
    const reloadedClick = await clickTool.handler({ ref: reloadedRef! }, context);
    check(reloadedClick.success, "real click lazily reinjects after reload");
    check(
      (await evaluate(client, "Boolean(globalThis[Symbol.for('pi-browser-harness.cursor.v1')])")) === true,
      "cursor is reinjected lazily after reload",
    );

    await evaluate(client, `(() => {
      const host = globalThis[Symbol.for("pi-browser-harness.cursor.v1")].host;
      host.addEventListener("focus", () => window.eventLog.push("focus:overlay"));
      host.addEventListener("pointerdown", () => window.eventLog.push("intercept:pointer"));
    })()`);

    const doubleClick = await clickTool.handler({ x: 100, y: 154, count: 2 }, context);
    check(doubleClick.success, "real double-click handler succeeds");
    check((await evaluate(client, "window.counts.double")) === 1, "fixture receives one double-click");

    const contextClick = await clickTool.handler({ x: 280, y: 154, button: "right" }, context);
    check(contextClick.success, "real context-menu handler succeeds");
    check((await evaluate(client, "window.counts.context")) === 1, "fixture receives one context-menu event");

    const dragged = await dragAndDropTool.handler({ startX: 90, startY: 250, endX: 350, endY: 250 }, context);
    check(dragged.success, "real drag handler succeeds");
    check((await evaluate(client, "window.counts.drop")) === 1, "fixture receives one drop");

    const scrolled = await scrollTool.handler({ x: 200, y: 430, deltaY: 120 }, context);
    check(scrolled.success, "real nested scroll handler succeeds");
    await wait(100);
    check(
      (await evaluate(client, "window.counts.wheel > 0 && document.getElementById('scroll').scrollTop > 0")) === true,
      "fixture receives wheel input and nested region scrolls",
    );

    const final = await cursorSnapshot(client);
    check(final?.["x"] === 200 && final["y"] === 430 && final["pressed"] === false, "final cursor coordinates are released");
    check(
      (await evaluate(client, "document.elementFromPoint(200, 430).id")) === "scroll-content",
      "elementFromPoint resolves the page target instead of the overlay",
    );

    const defaultScreenshot = await screenshotTool.handler({}, context);
    check(
      defaultScreenshot.success && defaultScreenshot.data.details?.["cursorSuppression"] === "ok",
      "default screenshot suppresses the cursor",
    );
    const cursorScreenshot = await screenshotTool.handler({ includeCursor: true }, context);
    check(
      cursorScreenshot.success && cursorScreenshot.data.details?.["cursorSuppression"] === "ok",
      "explicit screenshot cursor include succeeds strictly",
    );
    const defaultSnapshot = await snapshotTool.handler({ includeScreenshot: true }, context);
    check(
      defaultSnapshot.success && defaultSnapshot.data.details?.["cursorSuppression"] === "ok",
      "default snapshot screenshot suppresses the cursor",
    );
    const cursorIncludedSnapshot = await snapshotTool.handler({ includeScreenshot: true, includeCursor: true }, context);
    check(
      cursorIncludedSnapshot.success && cursorIncludedSnapshot.data.details?.["cursorSuppression"] === "ok",
      "explicit snapshot cursor include succeeds strictly",
    );

    const root = await client.session().call("DOM.getDocument", {});
    const host = root.success
      ? await client.session().call("DOM.querySelector", {
        nodeId: root.data.root.nodeId,
        selector: "[aria-hidden='true'][tabindex='-1']",
      })
      : undefined;
    const description = host?.success && host.data.nodeId !== 0
      ? await client.session().call("DOM.describeNode", { nodeId: host.data.nodeId })
      : undefined;
    const ax = await client.session().call("Accessibility.getFullAXTree", {});
    const hostBackendNodeId = description?.success ? description.data.node.backendNodeId : undefined;
    const exposedCursorNode = ax.success && hostBackendNodeId !== undefined
      ? ax.data.nodes.some((node: any) => node.backendDOMNodeId === hostBackendNodeId && node.ignored !== true)
      : true;
    check(hostBackendNodeId !== undefined && exposedCursorNode === false, "no valid AX node is exposed for the cursor");

    await evaluate(client, "document.getElementById('cover').showModal()");
    await wait(20);
    check(
      (await evaluate(client, "window.eventLog.includes('toggle:DIALOG')")) === true,
      "fixture logs the dialog Top Layer toggle",
    );
    const coveredScreenshot = await screenshotTool.handler({ includeCursor: true }, context);
    check(
      !coveredScreenshot.success && /Top Layer/.test(coveredScreenshot.error.message),
      "strict screenshot cursor include rejects a Top Layer-covered cursor",
    );
    check(
      (await evaluate(client, "window.eventLog.every((entry) => !entry.startsWith('focus:overlay') && !entry.startsWith('intercept:'))")) === true,
      "event log records no overlay focus or pointer interception",
    );
  } finally {
    if (tabId !== undefined) await client.closeTab(tabId);
    await client.stop();
  }

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exitCode = failed === 0 ? 0 : 1;
}

main().catch((error: unknown) => {
  console.error(error);
  process.exit(1);
});
