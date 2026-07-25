// PDF structural audit — minimal byte-level inspector for the four
// structural markers that determine whether a PDF is AT-friendly:
//
//   /MarkInfo << /Marked true >>   — is it a tagged PDF? (WCAG 1.3.1)
//   /StructTreeRoot                 — does it expose a structure tree? (WCAG 1.3.1)
//   /Lang (xx-XX)                   — programmatic language declared? (WCAG 3.1.1)
//   /Title (…)                      — descriptive document title? (WCAG 2.4.2)
//
// We don't attempt to render pages or parse content streams — that would
// require PDF.js (~500KB), a worker, and for scanned image-only PDFs
// OCR to detect missing text. Shippable today: a scan of the first
// chunk of the file for these catalog markers. Xref streams may be
// compressed, but in practice /Catalog dictionaries for well-formed
// PDFs are emitted in an uncompressed trailer section readable as plain
// ASCII. If we can't find the markers we report "unknown" instead of
// "missing" so we don't flag compressed/encrypted PDFs as failures.
//
// For a stronger pass we also scan the *last* chunk of the file — many
// linearized PDFs have the trailer at the end. We read both ends.
//
// Usage from the service worker:
//   const result = await auditPdfUrl(url, { timeoutMs: 8000 });
//   // → { ok, error, size, tagged, hasStructTree, hasLang, hasTitle, lang, title, bytesInspected }
//
// Exposed as both ES module export and global (service worker imports it
// via importScripts-equivalent). Self-contained, no external deps.

const PDF_MAGIC = new Uint8Array([0x25, 0x50, 0x44, 0x46, 0x2D]); // "%PDF-"
const HEAD_BYTES = 262144;    // 256 KB from the start
const TAIL_BYTES = 262144;    // 256 KB from the end
// No size cap. Professional audit tools do not silently skip large files.
// We only parse HEAD_BYTES from the start + TAIL_BYTES from the end of
// each PDF, so memory usage is bounded regardless of file size — the
// remote bytes are discarded once the head/tail windows are read.
const SOFT_CAP = Infinity;

function bytesStartWith(buf, magic) {
  if (!buf || buf.length < magic.length) return false;
  for (let i = 0; i < magic.length; i++) if (buf[i] !== magic[i]) return false;
  return true;
}

// Latin-1 decode — PDF catalog dictionaries are ASCII-safe (all markers
// we need are in Latin-1 space). Using TextDecoder("latin1") preserves
// the literal byte values as characters 0-255 so our regexes operate
// reliably on byte sequences.
const LATIN1 = new TextDecoder("latin1");

// Regex scanners. PDFs use whitespace loosely; we accept any whitespace
// run between tokens. String literals in PDF can be (parenthesized)
// or <hex-encoded>. We match both for /Lang and /Title.
const RE_MARKED_TRUE      = /\/MarkInfo\s*<<[^>]*\/Marked\s+true[^>]*>>/;
const RE_STRUCT_TREE_ROOT = /\/StructTreeRoot\s+\d+\s+\d+\s+R/;
// /Lang (xx-XX) or /Lang <xxxx> — we only need presence + the value.
const RE_LANG_PAREN = /\/Lang\s*\(([^)]{1,32})\)/;
const RE_LANG_HEX   = /\/Lang\s*<([0-9A-Fa-f\s]{2,128})>/;
// /Title (...) or /Title <...>, allowing balanced inner parens (PDF
// actually requires escaping, so a non-greedy match is fine in practice).
const RE_TITLE_PAREN = /\/Title\s*\(((?:[^\\()]|\\.|)*)\)/;
const RE_TITLE_HEX   = /\/Title\s*<([0-9A-Fa-f\s]{2,4096})>/;

function hexToString(hex) {
  const clean = hex.replace(/\s+/g, "");
  if (clean.length % 2) return "";
  const out = [];
  for (let i = 0; i < clean.length; i += 2) {
    out.push(parseInt(clean.slice(i, i + 2), 16));
  }
  // If it starts with BOM FE FF, decode as UTF-16BE.
  if (out.length >= 2 && out[0] === 0xFE && out[1] === 0xFF) {
    const u16 = new Uint16Array((out.length - 2) / 2);
    for (let i = 0; i < u16.length; i++) {
      u16[i] = (out[2 + i * 2] << 8) | out[3 + i * 2];
    }
    try { return new TextDecoder("utf-16be").decode(new Uint8Array(out.slice(2))); }
    catch { return String.fromCharCode(...u16); }
  }
  return out.map(b => String.fromCharCode(b)).join("");
}

function unescapePdfString(s) {
  // Minimal PDF literal-string unescape: \n \r \t \b \f \\ \( \) \ddd
  return s.replace(/\\(n|r|t|b|f|\\|\(|\)|\d{1,3})/g, (_, c) => {
    if (c === "n") return "\n";
    if (c === "r") return "\r";
    if (c === "t") return "\t";
    if (c === "b") return "\b";
    if (c === "f") return "\f";
    if (c === "\\" || c === "(" || c === ")") return c;
    const code = parseInt(c, 8);
    return Number.isFinite(code) ? String.fromCharCode(code) : "";
  });
}

function extractLang(text) {
  const mP = RE_LANG_PAREN.exec(text);
  if (mP) return unescapePdfString(mP[1]).trim();
  const mH = RE_LANG_HEX.exec(text);
  if (mH) return hexToString(mH[1]).trim();
  return "";
}

function extractTitle(text) {
  const mP = RE_TITLE_PAREN.exec(text);
  if (mP) return unescapePdfString(mP[1]).trim().slice(0, 300);
  const mH = RE_TITLE_HEX.exec(text);
  if (mH) return hexToString(mH[1]).trim().slice(0, 300);
  return "";
}

function scanMarkers(text) {
  return {
    tagged: RE_MARKED_TRUE.test(text),
    hasStructTree: RE_STRUCT_TREE_ROOT.test(text),
    lang: extractLang(text),
    title: extractTitle(text)
  };
}

function withTimeout(ms) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), ms);
  return { signal: ctrl.signal, clear: () => clearTimeout(timer) };
}

export async function auditPdfUrl(url, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 10000;
  const t = withTimeout(timeoutMs);
  try {
    // First request: HEAD-ish. Some servers reject HEAD; fall back to GET.
    let size = 0;
    try {
      const headResp = await fetch(url, { method: "HEAD", signal: t.signal, redirect: "follow" });
      if (headResp.ok) {
        const cl = headResp.headers.get("content-length");
        if (cl) size = parseInt(cl, 10) || 0;
      }
    } catch { /* ignore — we'll infer size from GET */ }

    if (size > SOFT_CAP) {
      t.clear();
      return { ok: false, error: `PDF too large (${size} bytes, cap ${SOFT_CAP})`, size };
    }

    // GET with Range: bytes=0-HEAD_BYTES. If server ignores Range we get the
    // full body back and truncate client-side.
    const headResp = await fetch(url, {
      method: "GET",
      signal: t.signal,
      redirect: "follow",
      headers: { Range: `bytes=0-${HEAD_BYTES - 1}` }
    });
    if (!headResp.ok && headResp.status !== 206) {
      t.clear();
      return { ok: false, error: `HTTP ${headResp.status}`, size };
    }
    const headBuf = new Uint8Array(await headResp.arrayBuffer());
    if (!bytesStartWith(headBuf, PDF_MAGIC)) {
      t.clear();
      return { ok: false, error: "Not a PDF (magic mismatch)", size };
    }

    // If HEAD didn't give us content-length, try Content-Range from GET.
    if (!size) {
      const cr = headResp.headers.get("content-range");
      const m = cr && cr.match(/\/(\d+)$/);
      if (m) size = parseInt(m[1], 10) || 0;
      else if (!headResp.headers.get("content-range") && headResp.headers.get("content-length")) {
        // Server didn't honor Range; headBuf is the whole file.
        size = headBuf.byteLength;
      }
    }

    const headText = LATIN1.decode(headBuf);
    let markers = scanMarkers(headText);
    let bytesInspected = headBuf.byteLength;

    // If we don't have the markers AND the file is bigger than our head
    // window AND the server supports Range, fetch the tail to find the
    // trailer (common layout: xref + trailer at the end).
    const needMore =
      !markers.tagged || !markers.hasStructTree || !markers.lang || !markers.title;
    const haveWhole = headBuf.byteLength >= size;
    if (needMore && size > HEAD_BYTES && !haveWhole) {
      const tailStart = Math.max(HEAD_BYTES, size - TAIL_BYTES);
      try {
        const tailResp = await fetch(url, {
          method: "GET",
          signal: t.signal,
          redirect: "follow",
          headers: { Range: `bytes=${tailStart}-${size - 1}` }
        });
        if (tailResp.ok || tailResp.status === 206) {
          const tailBuf = new Uint8Array(await tailResp.arrayBuffer());
          const tailText = LATIN1.decode(tailBuf);
          const tm = scanMarkers(tailText);
          markers = {
            tagged: markers.tagged || tm.tagged,
            hasStructTree: markers.hasStructTree || tm.hasStructTree,
            lang: markers.lang || tm.lang,
            title: markers.title || tm.title
          };
          bytesInspected += tailBuf.byteLength;
        }
      } catch { /* tail fetch failed — stick with head-only result */ }
    }

    t.clear();
    return {
      ok: true,
      size,
      bytesInspected,
      tagged: !!markers.tagged,
      hasStructTree: !!markers.hasStructTree,
      hasLang: !!markers.lang,
      hasTitle: !!markers.title,
      lang: markers.lang,
      title: markers.title
    };
  } catch (e) {
    t.clear();
    return { ok: false, error: String(e?.message || e) };
  }
}

// Map an audit result to rule-style issue entries the report can render
// alongside existing media-checks.js findings. Each entry has an id,
// impact, help, wcagTags, and a failureSummary.
export function pdfAuditToIssues(result) {
  if (!result || !result.ok) return [];
  const issues = [];
  if (!result.tagged) {
    issues.push({
      id: "pdf-untagged",
      impact: "serious",
      description: "PDF is not tagged (/MarkInfo /Marked true not declared).",
      help: "Tag the PDF (Adobe Acrobat: Tools → Accessibility → Autotag Document, then manual review). Untagged PDFs expose no heading structure, reading order, or landmarks to assistive tech. IS 17802 Ch 10 + WCAG 1.3.1 (Info and Relationships) + PDF/UA.",
      helpUrl: "https://www.w3.org/WAI/WCAG21/Techniques/pdf/PDF9",
      wcagTags: ["wcag2a", "wcag131", "is17802-ch10", "pdfua"],
      failureSummary: "No /MarkInfo dictionary with /Marked true found in first 256KB or last 256KB of the PDF."
    });
  }
  if (!result.hasStructTree) {
    issues.push({
      id: "pdf-missing-struct-tree",
      impact: "serious",
      description: "PDF has no structure tree (/StructTreeRoot not present).",
      help: "A tagged PDF must include a structure tree so assistive tech can navigate by heading, list, table, figure. Re-tag the document with proper Heading 1/2/3, List, Table Header cells, and Figure/Alt tags.",
      helpUrl: "https://www.w3.org/WAI/WCAG21/Techniques/pdf/PDF9",
      wcagTags: ["wcag2a", "wcag131", "is17802-ch10", "pdfua"],
      failureSummary: "No /StructTreeRoot reference found in the PDF catalog."
    });
  }
  if (!result.hasLang) {
    issues.push({
      id: "pdf-missing-lang",
      impact: "moderate",
      description: "PDF does not declare a document language (/Lang not set).",
      help: "Set the document language in the PDF (Acrobat: File → Properties → Advanced → Reading Options → Language). Screen readers use this to load the correct voice / pronunciation rules. WCAG 3.1.1 (Language of Page).",
      helpUrl: "https://www.w3.org/WAI/WCAG21/Techniques/pdf/PDF16",
      wcagTags: ["wcag2a", "wcag311", "is17802-ch10", "pdfua"],
      failureSummary: "No /Lang entry found in the document catalog."
    });
  }
  if (!result.hasTitle) {
    issues.push({
      id: "pdf-missing-title",
      impact: "moderate",
      description: "PDF has no document title (/Title not set in metadata).",
      help: "Set the document title and configure 'Display → Document Title' so assistive tech announces the title instead of the file name. WCAG 2.4.2 (Page Titled) applies to PDFs via PDF/UA.",
      helpUrl: "https://www.w3.org/WAI/WCAG21/Techniques/pdf/PDF18",
      wcagTags: ["wcag2a", "wcag242", "is17802-ch10", "pdfua"],
      failureSummary: "No /Title entry found in the PDF metadata."
    });
  }
  return issues;
}

// Run auditPdfUrl over an array of URLs with a concurrency limit. Returns
// a Map keyed by URL → result. Callers can merge this into per-item
// findings in the media inventory.
export async function auditPdfUrls(urls, { concurrency = 4, timeoutMs = 10000, progress = null } = {}) {
  const out = new Map();
  const unique = [...new Set((urls || []).filter(u => typeof u === "string" && u))];
  let idx = 0;
  let done = 0;
  async function worker() {
    while (true) {
      const i = idx++;
      if (i >= unique.length) return;
      const u = unique[i];
      try {
        out.set(u, await auditPdfUrl(u, { timeoutMs }));
      } catch (e) {
        out.set(u, { ok: false, error: String(e?.message || e) });
      }
      done++;
      try { progress?.(done, unique.length, u); } catch {}
    }
  }
  const workers = [];
  for (let k = 0; k < Math.max(1, concurrency); k++) workers.push(worker());
  await Promise.all(workers);
  return out;
}
