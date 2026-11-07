// Reads an image's pixel width from its header, without decoding it (sharp is optional). PNG keeps it in IHDR; JPEG
// in the first start-of-frame marker. Returns undefined for anything else or a truncated file.
export const imageWidth = (buf: Buffer): number | undefined => {
  if (buf.length >= 24 && buf.readUInt32BE(0) === 0x89504e47) return buf.readUInt32BE(16);
  if (buf.length < 4 || buf[0] !== 0xff || buf[1] !== 0xd8) return undefined;
  let i = 2;
  while (i + 9 < buf.length) {
    if (buf[i] !== 0xff) return undefined;
    const marker = buf[i + 1] ?? 0;
    const len = buf.readUInt16BE(i + 2);
    // SOF0..SOF15, minus DHT (C4), JPG (C8) and DAC (CC), carry the frame size: height then width.
    if (marker >= 0xc0 && marker <= 0xcf && marker !== 0xc4 && marker !== 0xc8 && marker !== 0xcc) return buf.readUInt16BE(i + 7);
    i += 2 + len;
  }
  return undefined;
};
