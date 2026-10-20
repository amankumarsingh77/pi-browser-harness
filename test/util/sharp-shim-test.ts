import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { classifySharpImportFailure } from "../../src/util/sharp-shim";

const withCode = (message: string, code: string): Error => Object.assign(new Error(message), { code });

describe("sharp import failure classification", () => {
  test("Node 22's ESM loader error reads as missing", () => {
    const e = withCode("Cannot find package 'sharp' imported from /x/src/util/sharp-shim.ts", "ERR_MODULE_NOT_FOUND");
    assert.deepEqual(classifySharpImportFailure(e), { kind: "missing" });
  });

  test("the CommonJS resolver error reads as missing", () => {
    const e = withCode("Cannot find module 'sharp'", "MODULE_NOT_FOUND");
    assert.deepEqual(classifySharpImportFailure(e), { kind: "missing" });
  });

  test("an installed sharp whose native binary fails to load is an error, not missing", () => {
    const e = new Error("Could not load the \"sharp\" module using the linux-x64 runtime");
    assert.deepEqual(classifySharpImportFailure(e), { kind: "error", message: e.message });
  });

  test("a message that merely mentions a missing module is not enough without the code", () => {
    const e = withCode("Cannot find module './build/Release/sharp.node'", "ERR_DLOPEN_FAILED");
    assert.equal(classifySharpImportFailure(e).kind, "error");
  });

  test("a non-Error throw is stringified", () => {
    assert.deepEqual(classifySharpImportFailure("nope"), { kind: "error", message: "nope" });
  });
});
