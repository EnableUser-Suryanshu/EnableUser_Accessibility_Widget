// Minimal PKZIP writer — enough to produce valid OOXML (.docx / .xlsx) files.
// Uses the ZIP "stored" (no compression) method so we don't need a deflate
// implementation. OOXML readers (Word, Excel, LibreOffice, Pages, Google
// Docs / Sheets) accept stored entries fine.
//
// Reference: APPNOTE.TXT (PKZIP File Format Specification) v6.3.10.
//
// Exports a class-free API:
//   const z = createZip();
//   await z.addText("word/document.xml", xmlString);
//   await z.addBytes("media/image1.png", uint8);
//   const blob = await z.finalize();
//
// The blob is a valid zip with MIME type application/zip.
//
// Only does what OOXML needs: UTF-8 filenames, stored method, no ZIP64,
// no encryption. No external libraries.

const ENC = new TextEncoder();

// ── CRC32 table (polynomial 0xEDB88320) ──────────────────────────────────
const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
    t[n] = c >>> 0;
  }
  return t;
})();

function crc32(bytes) {
  let c = 0xFFFFFFFF;
  for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
  return (c ^ 0xFFFFFFFF) >>> 0;
}

function dosDateTime(d = new Date()) {
  const year = d.getFullYear();
  const dosYear = Math.max(0, year - 1980);
  const time = (d.getHours() << 11) | (d.getMinutes() << 5) | (d.getSeconds() >> 1);
  const date = (dosYear << 9) | ((d.getMonth() + 1) << 5) | d.getDate();
  return { time, date };
}

export function createZip() {
  const entries = [];

  function addBytes(path, data) {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    entries.push({ path, data: bytes });
  }
  function addText(path, text) {
    addBytes(path, ENC.encode(text));
  }

  async function finalize() {
    const { time, date } = dosDateTime();
    const localParts = [];
    const centralParts = [];
    let offset = 0;

    for (const entry of entries) {
      const nameBytes = ENC.encode(entry.path);
      const crc = crc32(entry.data);
      const size = entry.data.length;

      // ── Local file header ──
      const lfh = new Uint8Array(30 + nameBytes.length);
      const lv = new DataView(lfh.buffer);
      lv.setUint32(0, 0x04034b50, true);          // local file header signature
      lv.setUint16(4, 20, true);                  // version needed
      lv.setUint16(6, 0x0800, true);              // general purpose bit flag: bit 11 = UTF-8 name
      lv.setUint16(8, 0, true);                   // compression method 0 = stored
      lv.setUint16(10, time, true);               // last mod time
      lv.setUint16(12, date, true);               // last mod date
      lv.setUint32(14, crc, true);                // crc-32
      lv.setUint32(18, size, true);               // compressed size
      lv.setUint32(22, size, true);               // uncompressed size
      lv.setUint16(26, nameBytes.length, true);   // file name length
      lv.setUint16(28, 0, true);                  // extra field length
      lfh.set(nameBytes, 30);

      localParts.push(lfh, entry.data);

      // ── Central directory header ──
      const cdh = new Uint8Array(46 + nameBytes.length);
      const cv = new DataView(cdh.buffer);
      cv.setUint32(0, 0x02014b50, true);          // central dir signature
      cv.setUint16(4, 20, true);                  // version made by
      cv.setUint16(6, 20, true);                  // version needed
      cv.setUint16(8, 0x0800, true);              // gp bit flag (UTF-8)
      cv.setUint16(10, 0, true);                  // compression method
      cv.setUint16(12, time, true);
      cv.setUint16(14, date, true);
      cv.setUint32(16, crc, true);
      cv.setUint32(20, size, true);               // compressed size
      cv.setUint32(24, size, true);               // uncompressed size
      cv.setUint16(28, nameBytes.length, true);
      cv.setUint16(30, 0, true);                  // extra length
      cv.setUint16(32, 0, true);                  // comment length
      cv.setUint16(34, 0, true);                  // disk number
      cv.setUint16(36, 0, true);                  // internal attributes
      cv.setUint32(38, 0, true);                  // external attributes
      cv.setUint32(42, offset, true);             // local header offset
      cdh.set(nameBytes, 46);

      centralParts.push(cdh);

      offset += lfh.length + size;
    }

    const localSize = offset;
    const centralSize = centralParts.reduce((n, p) => n + p.length, 0);
    const eocd = new Uint8Array(22);
    const ev = new DataView(eocd.buffer);
    ev.setUint32(0, 0x06054b50, true);            // EOCD signature
    ev.setUint16(4, 0, true);                     // disk number
    ev.setUint16(6, 0, true);                     // disk where cd starts
    ev.setUint16(8, entries.length, true);        // entries on this disk
    ev.setUint16(10, entries.length, true);       // total entries
    ev.setUint32(12, centralSize, true);          // size of central directory
    ev.setUint32(16, localSize, true);            // offset of start of cd
    ev.setUint16(20, 0, true);                    // comment length

    const all = [...localParts, ...centralParts, eocd];
    return new Blob(all, { type: "application/zip" });
  }

  return { addBytes, addText, finalize };
}
