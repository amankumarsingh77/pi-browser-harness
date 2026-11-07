import { test, describe } from "node:test";
import assert from "node:assert/strict";
import { imageWidth } from "../../src/util/image-size";

const png = (width: number): Buffer => {
  const b = Buffer.alloc(33);
  b.writeUInt32BE(0x89504e47, 0);
  b.writeUInt32BE(0x0d0a1a0a, 4);
  b.writeUInt32BE(13, 8);
  b.write("IHDR", 12, "ascii");
  b.writeUInt32BE(width, 16);
  b.writeUInt32BE(100, 20);
  return b;
};

// SOI, an APP0 segment to skip, then a baseline SOF0 carrying height 1240 and width 2846.
const jpeg = (): Buffer =>
  Buffer.from([
    0xff, 0xd8,
    0xff, 0xe0, 0x00, 0x04, 0x00, 0x00,
    0xff, 0xc0, 0x00, 0x11, 0x08, 0x04, 0xd8, 0x0b, 0x1e, 0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01,
  ]);

describe("imageWidth", () => {
  test("reads a PNG's width from IHDR", () => {
    assert.equal(imageWidth(png(2846)), 2846);
  });

  test("reads a JPEG's width from its first start-of-frame, skipping other segments", () => {
    assert.equal(imageWidth(jpeg()), 2846);
  });

  test("anything else, or a truncated file, is undefined", () => {
    assert.equal(imageWidth(Buffer.from("GIF89a")), undefined);
    assert.equal(imageWidth(Buffer.from([0xff, 0xd8, 0xff])), undefined);
  });
});
