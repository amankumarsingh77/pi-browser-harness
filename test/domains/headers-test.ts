import { describe, test } from "node:test";
import assert from "node:assert/strict";
import { Compile } from "typebox/compile";
import { clearHeadersTool, setHeadersTool } from "../../src/domains/headers";
import { createFakeClient, handlerContext } from "./fake-client";

describe("browser_set_headers", () => {
  test("sets headers on the current owned tab without echoing values", async () => {
    const fake = await createFakeClient();
    const result = await setHeadersTool.handler(
      {
        headers: {
          "x-tt-env": "ppe_mini_game_rating_phase4",
          "x-use-ppe": "1",
        },
      },
      handlerContext(fake.client),
    );

    assert.equal(result.success, true);
    assert.doesNotMatch(result.data.text, /ppe_mini_game_rating_phase4/);
    assert.deepEqual(result.data.details, {
      targetId: "t1",
      headerNames: ["x-tt-env", "x-use-ppe"],
      count: 2,
    });
    assert.deepEqual(fake.callsTo("Network.setExtraHTTPHeaders"), [
      {
        method: "Network.setExtraHTTPHeaders",
        params: {
          headers: {
            "x-tt-env": "ppe_mini_game_rating_phase4",
            "x-use-ppe": "1",
          },
        },
        sessionId: "s1",
      },
    ]);
  });

  test("refuses a current tab that is not owned by the harness", async () => {
    const fake = await createFakeClient();
    fake.ownership.remove("t1");
    const result = await setHeadersTool.handler({ headers: { "x-test": "value" } }, handlerContext(fake.client));

    assert.equal(result.success, false);
    assert.equal(result.error.kind, "invalid_state");
    assert.match(result.error.message, /not owned/);
    assert.equal(fake.callsTo("Network.setExtraHTTPHeaders").length, 0);
  });

  test("schema rejects empty or malformed header sets", () => {
    const validate = Compile(setHeadersTool.parameters);
    assert.equal(validate.Check({ headers: {} }), false);
    assert.equal(validate.Check({ headers: { "x-test": "line one\nline two" } }), false);
    assert.equal(validate.Check({ headers: { "x-test": "value" } }), true);
  });

  test("handler rejects invalid HTTP header names", async () => {
    const fake = await createFakeClient();
    const result = await setHeadersTool.handler({ headers: { "bad name": "value" } }, handlerContext(fake.client));

    assert.equal(result.success, false);
    assert.equal(result.error.kind, "invalid_args");
    assert.match(result.error.message, /Invalid HTTP header name/);
    assert.equal(fake.callsTo("Network.setExtraHTTPHeaders").length, 0);
  });
});

describe("browser_clear_headers", () => {
  test("clears extra headers on the current owned tab", async () => {
    const fake = await createFakeClient();
    const result = await clearHeadersTool.handler({}, handlerContext(fake.client));

    assert.equal(result.success, true);
    assert.deepEqual(fake.callsTo("Network.setExtraHTTPHeaders"), [
      {
        method: "Network.setExtraHTTPHeaders",
        params: { headers: {} },
        sessionId: "s1",
      },
    ]);
  });
});
