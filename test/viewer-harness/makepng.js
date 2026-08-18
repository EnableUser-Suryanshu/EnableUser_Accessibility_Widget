// Generate a real PNG so the harness exercises actual image decoding rather
// than a 1x1 placeholder stretched by CSS. Solid fill + a contrasting inner
// border, so a rendered thumbnail is unmistakable in a screenshot.
const zlib = require("zlib");

function crc32(buf) {
  let c, crc = 0xffffffff;
  for (let n = 0; n < buf.length; n++) {
    c = (crc ^ buf[n]) & 0xff;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    crc = c ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const td = Buffer.concat([Buffer.from(type, "ascii"), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td), 0);
  return Buffer.concat([len, td, crc]);
}

function png(width, height, fill, border) {
  const raw = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const off = y * (1 + width * 3);
    raw[off] = 0; // filter: none
    for (let x = 0; x < width; x++) {
      const edge = x < 8 || y < 8 || x >= width - 8 || y >= height - 8;
      const c = edge ? border : fill;
      const p = off + 1 + x * 3;
      raw[p] = c[0]; raw[p + 1] = c[1]; raw[p + 2] = c[2];
    }
  }
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;   // bit depth
  ihdr[9] = 2;   // colour type: truecolour
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk("IHDR", ihdr),
    chunk("IDAT", zlib.deflateSync(raw)),
    chunk("IEND", Buffer.alloc(0))
  ]);
}

const out = {
  // Full-page shots: three distinct colours so gallery cards are individually identifiable.
  "shot-page-1": png(480, 320, [37, 99, 235], [15, 23, 42]),
  "shot-page-2": png(480, 320, [22, 163, 74], [15, 23, 42]),
  "shot-page-3": png(480, 320, [161, 98, 7], [15, 23, 42]),
  // Element crops: the 400x300 minimum-context size the port now enforces.
  "shot-el-a": png(400, 300, [225, 29, 72], [15, 23, 42]),
  "shot-el-b": png(400, 300, [147, 51, 234], [15, 23, 42])
};

const asDataUrls = {};
for (const [k, v] of Object.entries(out)) {
  asDataUrls[k] = { dataUrl: `data:image/png;base64,${v.toString("base64")}`, bytes: v.length };
}
require("fs").writeFileSync(
  __dirname + "/shots.js",
  "window.__HARNESS_SHOTS = " + JSON.stringify(asDataUrls) + ";\n"
);
console.log("wrote shots.js with", Object.keys(out).length, "PNGs");
for (const [k, v] of Object.entries(out)) console.log(" ", k, v.length, "bytes");
