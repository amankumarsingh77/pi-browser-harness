import { test, describe, afterEach } from "node:test";
import assert from "node:assert/strict";
import { homedir } from "node:os";
import { join } from "node:path";
import { recordingPath, recordingsDir } from "../../src/util/paths";

const ENV_KEY = "PI_BROWSER_RECORDINGS_DIR";
const original = process.env[ENV_KEY];

afterEach(() => {
  if (original === undefined) delete process.env[ENV_KEY];
  else process.env[ENV_KEY] = original;
});

describe("recordingsDir", () => {
  test("S6: defaults to ~/.pi/browser-harness/recordings when unset", () => {
    delete process.env[ENV_KEY];
    assert.equal(recordingsDir(), join(homedir(), ".pi", "browser-harness", "recordings"));
  });

  test("S6: follows PI_BROWSER_RECORDINGS_DIR when set", () => {
    process.env[ENV_KEY] = "/tmp/custom-recordings";
    assert.equal(recordingsDir(), "/tmp/custom-recordings");
  });

  test("S6: an empty value falls back to the default, same as unset", () => {
    process.env[ENV_KEY] = "";
    assert.equal(recordingsDir(), join(homedir(), ".pi", "browser-harness", "recordings"));
  });
});

describe("recordingPath", () => {
  test("S6: sits under recordingsDir() and ends in .mp4", () => {
    delete process.env[ENV_KEY];
    const p = recordingPath("ns");
    assert.ok(p.startsWith(recordingsDir()));
    assert.match(p, /\.mp4$/);
  });

  test("S6: two calls are unique", () => {
    const a = recordingPath("ns");
    const b = recordingPath("ns");
    assert.notEqual(a, b);
  });

  test("rejects an invalid namespace", () => {
    assert.throws(() => recordingPath("not a namespace!"));
  });
});
