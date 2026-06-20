import { createDaemonTransport } from "../../src/cdp/daemon-transport";

async function main() {
  const t = createDaemonTransport("pi-live-test");
  const r = await t.connect("");
  console.log("Connect:", r.success ? "ok" : r.error.message);
  console.log("State:", t.state());

  const res = await t.request("Browser.getVersion", {});
  if (res.success) {
    const d = res.data as any;
    console.log("Browser:", d?.product ?? d);
  } else {
    console.log("Error:", res.error.message);
  }

  await t.close();
  console.log("Done");
}

main();
