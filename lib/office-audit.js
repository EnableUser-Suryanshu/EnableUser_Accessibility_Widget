// Byte-level Office document structural audit (docx / xlsx / pptx).
// Mirrors the pattern of lib/pdf-audit.js — no third-party libraries, no
// OOXML SDK dependency. We parse the zip container ourselves, extract the
// two or three parts we care about (docProps/core.xml + format-specific
// body part), and regex-scrape for the structural markers that identify
// whether the document is minimally AT-accessible:
//
//   • dc:title        — document has a title (otherwise ATs read filename)
//   • dc:language     — language declaration (WCAG 3.1.1)
//   • heading styles  — docx: any Heading1–Heading6 paragraph style present
//   • slide count     — pptx: at least one slide part exists
//   • sheet count     — xlsx: at least one worksheet declared
//
// Why regex on XML instead of DOMParser? DOMParser is not reliably exposed
// in MV3 service workers across Chrome versions; regex extraction of a
// handful of named elements from well-formed OOXML XML is robust enough
// for these structural checks and avoids an SDK dependency.
//
// No size cap. A professional audit tool does not silently skip large
// documents — if the service worker can fetch the bytes, we will parse
// them. The 15 s timeout bounds how long a single bad URL can stall the
// batch runner; concurrency is capped at 4 so we never hold more than
// four documents in memory at once.

const SOFT_MAX_BYTES = Infinity;
const DEFAULT_TIMEOUT_MS = 15000;

// ─────────────────────────────────────────────────────────────────────────
// Zip reader — enough to locate and extract specific named entries from
// an OOXML container. Implements the minimum of APPNOTE.TXT v6.3.10 that
// docx/xlsx/pptx actually use: EOCD lookup, central directory parse,
// local file header + deflate-raw or stored extraction.
// No ZIP64, no encryption, no multi-volume — OOXML writers only emit
// ZIP64 records for archives above 4 GiB, which we do not expect to
// encounter among link-surfaced site documents.
// ─────────────────────────────────────────────────────────────────────────

const SIG_EOCD = 0x06054b50;
const SIG_CENTRAL_DIR = 0x02014b50;
const SIG_LOCAL_FILE = 0x04034b50;

function readUint16LE(bytes, offset) {
  return bytes[offset] | (bytes[offset + 1] << 8);
}
function readUint32LE(bytes, offset) {
  return (bytes[offset] |
          (bytes[offset + 1] << 8) |
          (bytes[offset + 2] << 16) |
          (bytes[offset + 3] << 24)) >>> 0;
}

// Walk backwards from the end of the buffer looking for the EOCD signature.
// The EOCD record is at least 22 bytes and may have up to 65535 trailing
// bytes of comment after it — so we scan the last 65557 bytes.
function findEOCD(bytes) {
  const minStart = Math.max(0, bytes.length - 22 - 0xFFFF);
  for (let i = bytes.length - 22; i >= minStart; i--) {
    if (readUint32LE(bytes, i) === SIG_EOCD) return i;
  }
  return -1;
}

function parseCentralDirectory(bytes) {
  const eocd = findEOCD(bytes);
  if (eocd < 0) throw new Error("not a zip (no EOCD record)");
  const entryCount = readUint16LE(bytes, eocd + 10);
  const cdOffset = readUint32LE(bytes, eocd + 16);
  const entries = new Map();
  let p = cdOffset;
  for (let i = 0; i < entryCount; i++) {
    if (p + 46 > bytes.length) break;
    if (readUint32LE(bytes, p) !== SIG_CENTRAL_DIR) break;
    const method = readUint16LE(bytes, p + 10);
    const compressedSize = readUint32LE(bytes, p + 20);
    const uncompressedSize = readUint32LE(bytes, p + 24);
    const nameLen = readUint16LE(bytes, p + 28);
    const extraLen = readUint16LE(bytes, p + 30);
    const commentLen = readUint16LE(bytes, p + 32);
    const localHeaderOffset = readUint32LE(bytes, p + 42);
    const name = new TextDecoder("utf-8").decode(bytes.slice(p + 46, p + 46 + nameLen));
    entries.set(name, {
      method, compressedSize, uncompressedSize, localHeaderOffset
    });
    p += 46 + nameLen + extraLen + commentLen;
  }
  return entries;
}

async function extractEntryBytes(bytes, entry) {
  const off = entry.localHeaderOffset;
  if (off + 30 > bytes.length) throw new Error("local header out of bounds");
  if (readUint32LE(bytes, off) !== SIG_LOCAL_FILE) {
    throw new Error("local file header signature mismatch");
  }
  const nameLen = readUint16LE(bytes, off + 26);
  const extraLen = readUint16LE(bytes, off + 28);
  const dataOffset = off + 30 + nameLen + extraLen;
  const dataEnd = dataOffset + entry.compressedSize;
  if (dataEnd > bytes.length) throw new Error("entry data out of bounds");
  const compressed = bytes.slice(dataOffset, dataEnd);
  if (entry.method === 0) return compressed; // stored
  if (entry.method === 8) {
    // Deflate — OOXML always uses raw deflate (no zlib header) inside zip.
    const stream = new Blob([compressed]).stream().pipeThrough(
      new DecompressionStream("deflate-raw")
    );
    const ab = await new Response(stream).arrayBuffer();
    return new Uint8Array(ab);
  }
  throw new Error(`unsupported compression method ${entry.method}`);
}

async function extractEntryText(bytes, entry) {
  const raw = await extractEntryBytes(bytes, entry);
  return new TextDecoder("utf-8").decode(raw);
}

// ─────────────────────────────────────────────────────────────────────────
// Core metadata parse (docProps/core.xml)
// OOXML core-properties schema: dc:* + cp:* namespaces. Regexes match
// element *content* only — we don't try to reconstruct the tree, just
// pluck the values we care about.
// ─────────────────────────────────────────────────────────────────────────

const RE_DC_TITLE    = /<dc:title[^>]*>([^<]*)<\/dc:title>/i;
const RE_DC_LANGUAGE = /<dc:language[^>]*>([^<]*)<\/dc:language>/i;
const RE_DC_SUBJECT  = /<dc:subject[^>]*>([^<]*)<\/dc:subject>/i;
const RE_DC_CREATOR  = /<dc:creator[^>]*>([^<]*)<\/dc:creator>/i;

function decodeXmlEntities(s) {
  return String(s || "")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, hex) => String.fromCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_, dec) => String.fromCodePoint(parseInt(dec, 10)));
}

function parseCoreXml(xml) {
  return {
    title:    decodeXmlEntities((xml.match(RE_DC_TITLE)?.[1]    || "")).trim(),
    language: decodeXmlEntities((xml.match(RE_DC_LANGUAGE)?.[1] || "")).trim(),
    subject:  decodeXmlEntities((xml.match(RE_DC_SUBJECT)?.[1]  || "")).trim(),
    creator:  decodeXmlEntities((xml.match(RE_DC_CREATOR)?.[1]  || "")).trim()
  };
}

// ─────────────────────────────────────────────────────────────────────────
// Format detection
// ─────────────────────────────────────────────────────────────────────────

export function detectOfficeFormat(url) {
  if (!url) return null;
  const m = /\.(docx|xlsx|pptx)(?:[?#]|$)/i.exec(String(url));
  return m ? m[1].toLowerCase() : null;
}

// ─────────────────────────────────────────────────────────────────────────
// Main per-URL audit
// ─────────────────────────────────────────────────────────────────────────

export async function auditOfficeUrl(url, opts = {}) {
  const format = detectOfficeFormat(url);
  if (!format) return { ok: false, url, reason: "not a docx/xlsx/pptx extension" };

  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const ctrl = new AbortController();
  const timer = setTimeout(() => { try { ctrl.abort(); } catch {} }, timeoutMs);

  let bytes;
  try {
    const res = await fetch(url, { signal: ctrl.signal, credentials: "omit", cache: "no-store" });
    if (!res.ok) {
      return { ok: false, url, format, reason: `HTTP ${res.status}` };
    }
    const cl = Number(res.headers.get("content-length") || 0);
    if (cl > SOFT_MAX_BYTES) {
      return { ok: false, url, format, reason: `size ${cl} exceeds ${SOFT_MAX_BYTES} byte cap` };
    }
    const ab = await res.arrayBuffer();
    bytes = new Uint8Array(ab);
    if (bytes.length > SOFT_MAX_BYTES) {
      return { ok: false, url, format, reason: `body ${bytes.length} exceeds ${SOFT_MAX_BYTES} byte cap` };
    }
  } catch (err) {
    return { ok: false, url, format, reason: `fetch: ${String(err?.message || err)}` };
  } finally {
    clearTimeout(timer);
  }

  let entries;
  try {
    entries = parseCentralDirectory(bytes);
  } catch (err) {
    return { ok: false, url, format, reason: `zip: ${String(err?.message || err)}` };
  }

  // Core metadata — every OOXML file ships docProps/core.xml. A missing
  // core.xml is itself a signal that the file was produced by a non-
  // standard tool (or hand-authored), but we don't fail the whole audit
  // on that; we just surface empty values.
  let core = { title: "", language: "", subject: "", creator: "" };
  const coreEntry = entries.get("docProps/core.xml");
  if (coreEntry) {
    try {
      const xml = await extractEntryText(bytes, coreEntry);
      core = parseCoreXml(xml);
    } catch {}
  }

  const result = {
    ok: true, url, format,
    sizeBytes: bytes.length,
    title: core.title,
    language: core.language,
    subject: core.subject,
    creator: core.creator,
    // format-specific body markers, filled below
    hasHeadings: null,   // docx only
    slideCount: null,    // pptx only
    sheetCount: null     // xlsx only
  };

  if (format === "docx") {
    const body = entries.get("word/document.xml");
    if (body) {
      try {
        const xml = await extractEntryText(bytes, body);
        // Heading1..Heading9 in OOXML Word styles. The paragraph style
        // reference is <w:pStyle w:val="Heading1"/>. Some authoring tools
        // localise the style name (e.g. "Titre1" in French Word) but MS-
        // compiled templates always output the English canonical name.
        // This is heuristic: documents authored in non-English Word from a
        // template that preserved localised style names may report
        // hasHeadings=false even when they have headings. We accept that
        // false-negative rate to avoid false-positives from arbitrary
        // user-defined style names.
        result.hasHeadings = /<w:pStyle\b[^>]*\bw:val="Heading[1-9]"/i.test(xml);
      } catch {}
    }
  } else if (format === "xlsx") {
    const wb = entries.get("xl/workbook.xml");
    if (wb) {
      try {
        const xml = await extractEntryText(bytes, wb);
        // <sheet name="…" sheetId="…" r:id="…"/>
        const m = xml.match(/<sheet\s[^>]*\/>/gi);
        result.sheetCount = m ? m.length : 0;
      } catch {}
    }
  } else if (format === "pptx") {
    // Slide count = number of ppt/slides/slideN.xml parts. Fast to count
    // from the central directory without extracting any slide contents.
    let slideCount = 0;
    for (const name of entries.keys()) {
      if (/^ppt\/slides\/slide\d+\.xml$/i.test(name)) slideCount++;
    }
    result.slideCount = slideCount;
  }

  return result;
}

// ─────────────────────────────────────────────────────────────────────────
// Rule-shaped issue generator — mirrors the shape produced by
// pdfAuditToIssues + lib/media-checks.js so the report renderer and
// inventory writer can treat all findings uniformly.
// ─────────────────────────────────────────────────────────────────────────

// Issue shape mirrors pdfAuditToIssues() exactly: `id`, `impact`,
// `description`, `help`, `helpUrl`, `wcagTags[]`, `failureSummary`. The
// report renderer and inventory writer consume both shapes through the
// same code path, so deviating here would force a forked renderer.
const ISSUE_META = {
  "office-missing-title": {
    impact: "moderate",
    description: "Office document has no title in its core properties (dc:title is empty).",
    help: "Set the document title in File → Info → Properties → Title (Word/Excel/PowerPoint). Assistive technologies announce the title when the document opens; when empty, the filename is read instead, which is rarely meaningful. WCAG 2.4.2 (Page Titled) applies via the document format profiles.",
    helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/page-titled",
    wcagTags: ["wcag2a", "wcag242", "is17802-ch10"],
    failureSummary: "No dc:title content found in docProps/core.xml."
  },
  "office-missing-language": {
    impact: "moderate",
    description: "Office document does not declare a language (dc:language is empty).",
    help: "Set the document language (Word/Excel/PowerPoint → Review → Language → Set Proofing Language, then save). Screen readers use this to select voice, pronunciation, and hyphenation rules. WCAG 3.1.1 (Language of Page).",
    helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/language-of-page",
    wcagTags: ["wcag2a", "wcag311", "is17802-ch10"],
    failureSummary: "No dc:language content found in docProps/core.xml."
  },
  "docx-no-headings": {
    impact: "serious",
    description: "Word document uses no Heading paragraph styles (Heading 1–9).",
    help: "Apply Heading 1 / Heading 2 / Heading 3 styles to section titles in Word instead of manually bolding or enlarging text. Screen reader users navigate by heading to skim a document; without headings they must read linearly. WCAG 1.3.1 (Info and Relationships).",
    helpUrl: "https://www.w3.org/WAI/WCAG21/Techniques/general/G141",
    wcagTags: ["wcag2a", "wcag131", "is17802-ch10"],
    failureSummary: "word/document.xml contains no <w:pStyle w:val=\"Heading1-9\"> references. Documents authored from a non-English template that preserves localized style names may produce a false negative."
  },
  "pptx-no-slides": {
    impact: "serious",
    description: "PowerPoint file contains no slide parts.",
    help: "The container appears empty or corrupt — reopen in PowerPoint and verify the slide count, then re-save. An accessible PowerPoint needs at least one slide with a title placeholder.",
    helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships",
    wcagTags: ["wcag2a", "wcag131", "is17802-ch10"],
    failureSummary: "No ppt/slides/slideN.xml parts found in the OOXML container."
  },
  "xlsx-no-sheets": {
    impact: "serious",
    description: "Excel workbook declares no worksheets.",
    help: "The workbook appears empty or corrupt — reopen in Excel and verify that at least one worksheet exists. An accessible workbook needs named sheets with header rows.",
    helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/info-and-relationships",
    wcagTags: ["wcag2a", "wcag131", "is17802-ch10"],
    failureSummary: "xl/workbook.xml contains no <sheet .../> elements."
  }
};

export function officeAuditToIssues(r) {
  if (!r || !r.ok) return [];
  const issues = [];
  const push = (id) => {
    const meta = ISSUE_META[id];
    if (!meta) return;
    issues.push({
      id,
      impact: meta.impact,
      description: meta.description,
      help: meta.help,
      helpUrl: meta.helpUrl,
      wcagTags: meta.wcagTags.slice(),
      failureSummary: meta.failureSummary
    });
  };

  if (!r.title) push("office-missing-title");
  if (!r.language) push("office-missing-language");
  if (r.format === "docx" && r.hasHeadings === false) push("docx-no-headings");
  if (r.format === "pptx" && r.slideCount === 0) push("pptx-no-slides");
  if (r.format === "xlsx" && r.sheetCount === 0) push("xlsx-no-sheets");

  return issues;
}

// ─────────────────────────────────────────────────────────────────────────
// Batch runner — parallel-limited audit across a list of URLs, same
// interface as auditPdfUrls() so background.js can plug it in identically.
// ─────────────────────────────────────────────────────────────────────────

export async function auditOfficeUrls(urls, opts = {}) {
  const concurrency = Math.max(1, opts.concurrency || 4);
  const timeoutMs = opts.timeoutMs || DEFAULT_TIMEOUT_MS;
  const results = new Map();
  let cursor = 0;
  async function worker() {
    while (cursor < urls.length) {
      const url = urls[cursor++];
      const r = await auditOfficeUrl(url, { timeoutMs });
      results.set(url, r);
      if (typeof opts.progress === "function") {
        try { opts.progress(results.size, urls.length, url); } catch {}
      }
    }
  }
  const workerCount = Math.min(concurrency, Math.max(1, urls.length));
  await Promise.all(Array.from({ length: workerCount }, worker));
  return results;
}
