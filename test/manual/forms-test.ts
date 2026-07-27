/**
 * Manual integration test for the form-filling tools.
 *
 * Exercises browser_snapshot (ref surfacing) + browser_fill_form / browser_fill /
 * browser_select_option / browser_set_checked against a data:-URL fixture that
 * includes a plain input, a textarea, a "controlled" input (commits its model
 * only on the `input` event — the realistic failure mode for naive value-setting),
 * a native <select>, a checkbox, and a contenteditable.
 *
 * Requires the daemon running + a real Chrome (same as live-daemon-test.ts).
 * Run: npx tsx test/manual/forms-test.ts
 */
import { createDaemonTransport } from "../../src/cdp/daemon-transport";
import { createBrowserClient } from "../../src/client";
import { fillTool, selectOptionTool, setCheckedTool } from "../../src/domains/form";
import { fillFormTool } from "../../src/domains/form-batch";

let passed = 0;
let failed = 0;
const check = (cond: boolean, label: string): void => {
  if (cond) { passed++; console.log(`  ✓ ${label}`); }
  else { failed++; console.error(`  ✗ ${label}`); }
};

// Minimal handler context — the form/snapshot handlers only read `client`.
const mkCtx = (client: any): any => ({
  client,
  signal: undefined,
  onUpdate: () => {},
  extensionCtx: { cwd: process.cwd() },
});

const FIXTURE = `
<!doctype html><html><body>
  <h1>Form fixture</h1>
  <input id="plain" aria-label="plain" />
  <textarea id="ta" aria-label="ta"></textarea>
  <input id="controlled" aria-label="controlled" />
  <span id="model"></span>
  <select id="sel" aria-label="country">
    <option value="us">United States</option>
    <option value="uk">United Kingdom</option>
    <option value="ca">Canada</option>
  </select>
  <input type="checkbox" id="chk" aria-label="agree" />
  <div id="editable" role="textbox" aria-label="bio" contenteditable="true"></div>
  <script>
    // Controlled input: its "model" updates ONLY when an input event fires.
    // A naive value-set that skips the input event leaves the model stale.
    var model = "";
    var c = document.getElementById("controlled");
    c.addEventListener("input", function () { model = c.value; document.getElementById("model").textContent = model; });
    window.__model = function () { return model; };
  </script>
</body></html>`;

const publishRefs = async (client: any, names: ReadonlyArray<string>): Promise<Record<string, string | undefined>> => {
  const ax = await client.session().call("Accessibility.getFullAXTree", {});
  if (!ax.success) return {};
  const byName = new Map<string, number>();
  for (const n of (ax.data as any).nodes as any[]) {
    if (typeof n?.name?.value === "string" && typeof n.backendDOMNodeId === "number" && !byName.has(n.name.value)) {
      byName.set(n.name.value, n.backendDOMNodeId);
    }
  }
  const refMap = new Map<string, number>();
  const refSig = new Map<string, string>();
  const out: Record<string, string | undefined> = {};
  names.forEach((name, i) => {
    const backendId = byName.get(name);
    if (backendId === undefined) return;
    const ref = `e${i + 1}`;
    refMap.set(ref, backendId);
    refSig.set(ref, `|${name}||`);
    out[name] = ref;
  });
  client.session().setRefMap(refMap, refSig);
  return out;
};

async function main(): Promise<void> {
  const transport = createDaemonTransport("pi-forms-test");
  const client = createBrowserClient({ namespace: "pi-forms-test", transport });
  const ctx = mkCtx(client);

  const started = await client.start();
  if (!started.success) { console.error("Could not start client:", started.error.message); process.exit(1); }

  const url = "data:text/html," + encodeURIComponent(FIXTURE);
  const tab = await client.newTab(url);
  check(tab.success, `Opened fixture tab: ${tab.success ? "ok" : tab.error.message}`);
  // Give the inline script a beat to wire up listeners.
  await new Promise((r) => setTimeout(r, 300));

  const byName = await publishRefs(client, ["plain", "ta", "controlled", "country", "agree", "bio"]);
  const refs = {
    plain: byName["plain"],
    ta: byName["ta"],
    controlled: byName["controlled"],
    sel: byName["country"],
    chk: byName["agree"],
    editable: byName["bio"],
  };
  for (const [k, v] of Object.entries(refs)) check(typeof v === "string", `ref present for ${k} (${v})`);

  // ── Batch fill text fields ──────────────────────────────────────────────────
  const fill = await fillFormTool.handler({
    fields: [
      { ref: refs.plain!, value: "hello plain" },
      { ref: refs.ta!, value: "multi\nline" },
      { ref: refs.controlled!, value: "ctrl-value" },
      { ref: refs.editable!, value: "my bio" },
    ],
  }, ctx);
  check(fill.success, "browser_fill_form succeeded");
  if (fill.success) console.log("    " + fill.data.text);

  // ── Select + checkbox ───────────────────────────────────────────────────────
  const sel = await selectOptionTool.handler({ ref: refs.sel!, label: "Canada" }, ctx);
  check(sel.success, `browser_select_option by label: ${sel.success ? sel.data.text : (sel as any).error.message}`);
  const chk = await setCheckedTool.handler({ ref: refs.chk!, checked: true }, ctx);
  check(chk.success, `browser_set_checked: ${chk.success ? chk.data.text : (chk as any).error.message}`);

  // ── Verify committed state via JS reads ─────────────────────────────────────
  const read = async (expr: string): Promise<unknown> => {
    const r = await client.evaluateJs(expr);
    return r.success ? r.data : `ERR:${r.error.message}`;
  };
  check((await read("document.getElementById('plain').value")) === "hello plain", "plain input value committed");
  check((await read("document.getElementById('ta').value")) === "multi\nline", "textarea value committed");
  // The controlled input's MODEL (input-event-driven) must reflect the fill —
  // proves browser_fill fired the input event, not just set the DOM value.
  check((await read("window.__model()")) === "ctrl-value", "controlled input model committed (input event fired)");
  check((await read("document.getElementById('editable').textContent")) === "my bio", "contenteditable text committed");
  check((await read("document.getElementById('sel').value")) === "ca", "select value committed");
  check((await read("document.getElementById('chk').checked")) === true, "checkbox checked committed");

  // ── No-matching-option path ─────────────────────────────────────────────────
  const badSel = await selectOptionTool.handler({ ref: refs.sel!, label: "Atlantis" }, ctx);
  check(!badSel.success && (badSel as any).error.kind === "invalid_state", "select with no match → invalid_state error");

  // ── Stale ref path ──────────────────────────────────────────────────────────
  const staleRef = refs.plain!;
  const nav = await client.session().call("Page.navigate", { url: "data:text/html," + encodeURIComponent("<body>gone</body>") });
  check(nav.success, "navigated away to invalidate refs");
  await new Promise((r) => setTimeout(r, 300));
  const stale = await fillTool.handler({ ref: staleRef, value: "x" }, ctx);
  check(!stale.success && (stale as any).error.kind === "invalid_state", "fill on stale ref → invalid_state error");

  await client.closeTab(tab.success ? (tab.data as string) : "");
  await client.stop();

  console.log(`\n${passed} passed, ${failed} failed`);
  process.exit(failed === 0 ? 0 : 1);
}

main().catch((e) => { console.error(e); process.exit(1); });
