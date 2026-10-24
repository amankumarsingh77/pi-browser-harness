import { test, describe, after, before } from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import { fetchRedirectTarget } from "../../src/domains/search/redirect-resolver";

let server: Server;
let base = "";

before(async () => {
  server = createServer((req, res) => {
    if (req.url === "/302") {
      res.writeHead(302, { location: "https://target.example/real/path.php" });
      res.end();
      return;
    }
    if (req.url === "/relative") {
      res.writeHead(302, { location: "/elsewhere" });
      res.end();
      return;
    }
    if (req.url === "/slow") {
      setTimeout(() => { res.writeHead(302, { location: "https://late.example/" }); res.end(); }, 2000);
      return;
    }
    res.writeHead(200, { "content-type": "text/html" });
    res.end("<html>not a redirect</html>");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const addr = server.address();
  if (addr === null || typeof addr === "string") throw new Error("no port");
  base = `http://127.0.0.1:${addr.port}`;
});

after(() => { server.close(); });

describe("fetchRedirectTarget", () => {
  test("refuses to fetch anything that is not a Google /goto url", async () => {
    assert.equal(await fetchRedirectTarget(`${base}/302`, AbortSignal.timeout(1000), { requireGoto: true }), undefined);
  });

  test("returns the Location of a 302 without following it", async () => {
    assert.equal(await fetchRedirectTarget(`${base}/302`, AbortSignal.timeout(1000), { requireGoto: false }), "https://target.example/real/path.php");
  });

  test("resolves a relative Location against the request url", async () => {
    assert.equal(await fetchRedirectTarget(`${base}/relative`, AbortSignal.timeout(1000), { requireGoto: false }), `${base}/elsewhere`);
  });

  test("a 200 is not a redirect", async () => {
    assert.equal(await fetchRedirectTarget(`${base}/200`, AbortSignal.timeout(1000), { requireGoto: false }), undefined);
  });

  test("an aborted request resolves to undefined rather than throwing", async () => {
    assert.equal(await fetchRedirectTarget(`${base}/slow`, AbortSignal.timeout(100), { requireGoto: false }), undefined);
  });

  test("a connection failure resolves to undefined", async () => {
    assert.equal(await fetchRedirectTarget("http://127.0.0.1:1/x", AbortSignal.timeout(1000), { requireGoto: false }), undefined);
  });
});
