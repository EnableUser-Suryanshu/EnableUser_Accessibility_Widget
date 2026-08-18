// Minimal OOXML .xlsx generator. Same approach as docx-writer: build the
// required OOXML parts and wrap them in a stored-mode zip.
//
// Emits four sheets:
//   1. Pages          — one row per crawled URL with template, content-type
//                        flags, and element counts.
//   2. Templates      — one row per template with aggregated flags.
//   3. Proposed Sample — one row per URL chosen for the audit (one per
//                        template + critical-path).
//   4. Test Matrix    — rows = templates, cols = manual checks; cells mark
//                        "Required" / "N/A" so the auditor can tick them off.
//
// Uses shared strings for deduplication. Bold header row via a minimal
// styles.xml.

import { createZip } from "./zip-writer.js";
import { deriveFromTags } from "./wcag-tags.js";
import { MANUAL_TESTS, MANUAL_CHECKLIST_VERSION, MACHINE_ASSIST, testApplicability } from "./manual-checklist.js";

// ── Shared-strings helper ──────────────────────────────────────────────
function createSharedStrings() {
  const map = new Map();
  const list = [];
  function add(str) {
    if (!map.has(str)) {
      map.set(str, list.length);
      list.push(str);
    }
    return map.get(str);
  }
  function xml() {
    const ss = list.map(s => `<si><t xml:space="preserve">${esc(s)}</t></si>`).join("");
    return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="${list.length}" uniqueCount="${list.length}">${ss}</sst>`;
  }
  return { add, xml, get size() { return list.length; } };
}

// Excel's hard per-cell character limit. Overflow triggers the
// "repair-required" dialog on open.
const CELL_MAX_LEN = 32000;

function esc(s) {
  let str = String(s ?? "");
  // XML 1.0 forbids C0 control chars except \t \n \r. Axe's node.html blobs
  // occasionally carry NUL or other control bytes when the source DOM had
  // them (binary attribute values, server-injected stray chars). Strip them
  // or Excel will flag the entire workbook as corrupt.
  str = str.replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, "");
  // Excel rejects cells > 32,767 chars. Truncate with a marker so the user
  // knows content was cut rather than silently lost.
  if (str.length > CELL_MAX_LEN) str = str.slice(0, CELL_MAX_LEN - 15) + "… [truncated]";
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// Convert 0-based column index to A, B, ..., Z, AA, AB ...
function colLetter(n) {
  let s = "";
  n = n + 1;
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}

// ── Sheet builder ──────────────────────────────────────────────────────
// Style indices (see buildStyles):
//   0 = default (no formatting)
//   1 = bold white-on-blue header (no wrap — headers are short)
//   2 = body cell with wrapText + top alignment (long sentences fold)
//   3 = bold header with wrapText (for long header labels)
//
// Options:
//   colWidths      — per-column widths in Excel character units
//   wrapText       — apply wrap-text style to body/header cells (default on)
//   autoFilter     — emit <autoFilter> spanning the data range so clicking
//                    a header drops down Sort/Filter (default on). Sheets
//                    with mixed layouts (e.g. the Overview sheet) should
//                    pass `false`.
//   freezeFirstCol — also freeze column A, so on wide sheets the URL stays
//                    visible as you scroll right (default off).
function buildSheet(rows, ss, {
  headerBold = true,
  colWidths = null,
  wrapText = true,
  autoFilter = true,
  freezeFirstCol = false,
  // Optional: Map<rowNum1Indexed, heightInPoints> — rows with custom height.
  // Used by the Pages sheet when it embeds thumbnails so each row stretches
  // tall enough to show the image.
  rowHeights = null,
  // Optional: string like "rId1" — if present, emits <drawing r:id="..."/>
  // at the end of the sheet so Excel will render the linked drawing part.
  // Also means a matching sheet-level rels file must be written elsewhere
  // in the workbook (xl/worksheets/_rels/sheetN.xml.rels).
  drawingRelId = null
} = {}) {
  const rowParts = rows.map((row, rIdx) => {
    const rowNum = rIdx + 1;
    const cells = row.map((v, cIdx) => {
      const ref = `${colLetter(cIdx)}${rowNum}`;
      const isHeader = rIdx === 0 && headerBold;
      let styleIdx;
      if (isHeader && wrapText) styleIdx = 3;
      else if (isHeader) styleIdx = 1;
      else if (wrapText) styleIdx = 2;
      else styleIdx = 0;
      const sAttr = styleIdx > 0 ? ` s="${styleIdx}"` : "";

      if (v === null || v === undefined || v === "") return `<c r="${ref}"${sAttr}/>`;
      if (typeof v === "number" && !Number.isNaN(v)) {
        return `<c r="${ref}"${sAttr}><v>${v}</v></c>`;
      }
      const sIdx = ss.add(String(v));
      return `<c r="${ref}" t="s"${sAttr}><v>${sIdx}</v></c>`;
    }).join("");
    const ht = rowHeights && rowHeights.get(rowNum);
    const rowAttrs = ht
      ? ` r="${rowNum}" ht="${ht}" customHeight="1"`
      : ` r="${rowNum}"`;
    return `<row${rowAttrs}>${cells}</row>`;
  }).join("");

  const maxCols = rows.reduce((n, r) => Math.max(n, r.length), 1);
  const lastColLetter = colLetter(maxCols - 1);
  const dim = `A1:${lastColLetter}${rows.length}`;

  // <cols> — per-column widths in Excel's character units. With wrap-text
  // enabled above, content folds inside the fixed width instead of
  // overflowing the row.
  let colsXml = "";
  if (colWidths && colWidths.length) {
    const parts = colWidths.map((w, i) =>
      `<col min="${i + 1}" max="${i + 1}" width="${w}" customWidth="1"/>`
    ).join("");
    colsXml = `<cols>${parts}</cols>`;
  }

  // <autoFilter> must come AFTER <sheetData> per OOXML spec. Spans the full
  // data range so every header becomes a Sort/Filter dropdown.
  const filterXml = (autoFilter && rows.length > 1)
    ? `<autoFilter ref="A1:${lastColLetter}${rows.length}"/>`
    : "";

  // <drawing> reference — if provided, points at a worksheet-rel entry that
  // resolves to xl/drawings/drawingN.xml. Must appear AFTER <autoFilter>.
  const drawingXml = drawingRelId
    ? `<drawing r:id="${drawingRelId}"/>`
    : "";

  // Freeze panes: always row 1 (header stays visible scrolling down).
  // Optionally also column A (URL stays visible scrolling right on wide sheets).
  const xSplit = freezeFirstCol ? 1 : 0;
  const paneAttrs = [
    xSplit > 0 ? `xSplit="${xSplit}"` : null,
    `ySplit="1"`,
    `topLeftCell="${colLetter(xSplit)}2"`,
    `activePane="${xSplit > 0 ? "bottomRight" : "bottomLeft"}"`,
    `state="frozen"`
  ].filter(Boolean).join(" ");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="${dim}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ${paneAttrs}/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  ${colsXml}
  <sheetData>${rowParts}</sheetData>
  ${filterXml}
  ${drawingXml}
</worksheet>`;
}

function buildWorkbook(sheetNames) {
  const sheets = sheetNames.map((name, i) =>
    `<sheet name="${esc(name)}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`
  ).join("");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <sheets>${sheets}</sheets>
</workbook>`;
}

function buildWorkbookRels(sheetCount) {
  const rels = [];
  for (let i = 0; i < sheetCount; i++) {
    rels.push(`<Relationship Id="rId${i + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet${i + 1}.xml"/>`);
  }
  rels.push(`<Relationship Id="rId${sheetCount + 1}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>`);
  rels.push(`<Relationship Id="rId${sheetCount + 2}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>`);
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
}

function buildRootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>
</Relationships>`;
}

function buildContentTypes(sheetCount, { drawings = 0, hasPng = false } = {}) {
  const overrides = [];
  for (let i = 1; i <= sheetCount; i++) {
    overrides.push(`<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  }
  // Embedded drawings (thumbnails) contribute one xl/drawings/drawingN.xml
  // override each plus an image/png default for the raw bitmap parts.
  for (let i = 1; i <= drawings; i++) {
    overrides.push(`<Override PartName="/xl/drawings/drawing${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.drawing+xml"/>`);
  }
  const pngDefault = hasPng
    ? `<Default Extension="png" ContentType="image/png"/>`
    : "";
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  ${pngDefault}
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  ${overrides.join("")}
</Types>`;
}

// ─────────────────────────────────────────────────────────────────────
// OOXML drawing part — ties embedded images to cells in a worksheet.
// Excel's SpreadsheetML references images through a chain:
//   sheet.xml → sheet rels → drawingN.xml → drawing rels → media/imageN.png
//
// We emit a `oneCellAnchor` per thumbnail: the image is anchored at the
// top-left of a specific cell and extends by an explicit width/height in
// EMUs (1 px at 96dpi = 9525 EMU). oneCellAnchor (not twoCellAnchor) means
// the image size is fixed and independent of row heights — rows can grow
// without warping the image.
// ─────────────────────────────────────────────────────────────────────
const EMU_PER_PX = 9525;

function buildDrawingXml(thumbPositions, previewColIdx0) {
  const anchors = thumbPositions.map((t, i) => {
    const imgId = i + 1; // 1-based drawing-local id
    const relId = `rId${i + 1}`; // sheet-to-drawing is rId1; drawing-to-image is rId1..N (separate scope)
    const cx = Math.max(1, Math.round((t.width || 1) * EMU_PER_PX));
    const cy = Math.max(1, Math.round((t.height || 1) * EMU_PER_PX));
    // OOXML rows/cols in drawings are 0-indexed. Pages sheet row 1 is the
    // header (row 0 in drawing coords). A data row at 1-indexed rowNum=N
    // corresponds to drawing row (N-1).
    const rowIdx0 = Math.max(0, t.rowNum - 1);
    return `<xdr:oneCellAnchor>
  <xdr:from>
    <xdr:col>${previewColIdx0}</xdr:col><xdr:colOff>19050</xdr:colOff>
    <xdr:row>${rowIdx0}</xdr:row><xdr:rowOff>19050</xdr:rowOff>
  </xdr:from>
  <xdr:ext cx="${cx}" cy="${cy}"/>
  <xdr:pic>
    <xdr:nvPicPr>
      <xdr:cNvPr id="${imgId}" name="Preview ${imgId}"/>
      <xdr:cNvPicPr><a:picLocks noChangeAspect="1"/></xdr:cNvPicPr>
    </xdr:nvPicPr>
    <xdr:blipFill>
      <a:blip xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships" r:embed="${relId}"/>
      <a:stretch><a:fillRect/></a:stretch>
    </xdr:blipFill>
    <xdr:spPr>
      <a:xfrm><a:off x="0" y="0"/><a:ext cx="${cx}" cy="${cy}"/></a:xfrm>
      <a:prstGeom prst="rect"><a:avLst/></a:prstGeom>
    </xdr:spPr>
  </xdr:pic>
  <xdr:clientData/>
</xdr:oneCellAnchor>`;
  }).join("\n");

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<xdr:wsDr xmlns:xdr="http://schemas.openxmlformats.org/drawingml/2006/spreadsheetDrawing" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
${anchors}
</xdr:wsDr>`;
}

function buildDrawingRels(thumbCount, imageOffset = 0) {
  const rels = [];
  for (let i = 1; i <= thumbCount; i++) {
    rels.push(`<Relationship Id="rId${i}" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/image" Target="../media/image${imageOffset + i}.png"/>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${rels.join("")}</Relationships>`;
}

// Issue Screenshots sheet — one row per violating element that has a captured,
// highlighted element screenshot, with the cropped image embedded in column A
// (same oneCellAnchor pattern as the Pages sheet). Capped so a huge crawl
// can't bloat the workbook.
// Was 300, which silently stopped embedding previews partway through a large
// crawl's Issue Screenshots sheet — rows 301+ appeared with an empty Preview
// cell, indistinguishable from a finding whose capture had genuinely failed.
// Every captured shot is now embedded.
//
// The cost is workbook size: each thumbnail is capped at 300px wide by
// buildThumbnailMap (~20-60KB), so a crawl with 2000 element shots adds roughly
// 40-120MB. That is a slow download rather than a broken file, and the operator
// controls it directly by turning screenshots off or crawling fewer URLs.
const MAX_ISSUE_SHOTS = Infinity;
function buildIssueScreenshotsSheet(inventory, thumbnails) {
  const rows = [["Preview", "URL", "Rule ID", "Impact", "Target", "Success Criteria"]];
  const thumbPositions = [];
  if (!(thumbnails instanceof Map) || thumbnails.size === 0) return { rows, thumbPositions };
  for (const p of (inventory.pages || [])) {
    if (p.error) continue;
    for (const v of (p.audit?.violations || [])) {
      const derived = deriveFromTags(v.tags || []);
      for (const n of (v.nodes || [])) {
        const id = n.elementShotId;
        if (!id || !thumbnails.has(id)) continue;
        if (thumbPositions.length >= MAX_ISSUE_SHOTS) return { rows, thumbPositions };
        rows.push(["", p.url, v.ruleId || v.id || "", v.impact || "", (n.target || []).join(" "), derived.successCriteria]);
        const t = thumbnails.get(id);
        thumbPositions.push({ rowNum: rows.length, shotId: id, width: t.width, height: t.height });
      }
    }
  }
  return { rows, thumbPositions };
}

function buildSheetRelsForDrawing(drawingIndex) {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/drawing" Target="../drawings/drawing${drawingIndex}.xml"/>
</Relationships>`;
}

function buildStyles() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">
  <fonts count="2">
    <font><sz val="11"/><name val="Calibri"/></font>
    <font><b/><sz val="11"/><color rgb="FFFFFFFF"/><name val="Calibri"/></font>
  </fonts>
  <fills count="3">
    <fill><patternFill patternType="none"/></fill>
    <fill><patternFill patternType="gray125"/></fill>
    <fill><patternFill patternType="solid"><fgColor rgb="FF1E40AF"/></patternFill></fill>
  </fills>
  <borders count="1"><border/></borders>
  <cellStyleXfs count="1"><xf numFmtId="0" fontId="0" fillId="0" borderId="0"/></cellStyleXfs>
  <cellXfs count="4">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1" applyAlignment="1"><alignment vertical="top" wrapText="1"/></xf>
  </cellXfs>
</styleSheet>`;
}

// ── Embedded-image drawing parts ───────────────────────────────────────
// One drawing per spec. For each we write: xl/media/imageN.png,
// xl/drawings/drawingK.xml, xl/drawings/_rels/drawingK.xml.rels, and
// xl/worksheets/_rels/sheet{S}.xml.rels.
//
// Media images are numbered GLOBALLY across every drawing (image1..imageN)
// while each drawing's rels reference them through `offset` — the count of
// images already emitted by previous specs. Getting that offset wrong does not
// throw; it silently points a preview at another screenshot, or produces a
// workbook Excel refuses to open. test/xlsx-drawings.test.mjs pins it.
//
// Shared by the inventory and classic-report workbooks so the offset arithmetic
// exists once rather than being reimplemented per builder.
function emitDrawingParts(z, drawingSpecs, thumbnails) {
  let imageCounter = 0;
  drawingSpecs.forEach((spec, di) => {
    const drawingNo = di + 1;
    const offset = imageCounter;
    for (const t of spec.positions) {
      imageCounter++;
      const thumb = thumbnails.get(t.shotId);
      if (thumb?.bytes) z.addBytes(`xl/media/image${imageCounter}.png`, thumb.bytes);
    }
    z.addText(`xl/drawings/drawing${drawingNo}.xml`, buildDrawingXml(spec.positions, 0));
    z.addText(`xl/drawings/_rels/drawing${drawingNo}.xml.rels`, buildDrawingRels(spec.positions.length, offset));
    z.addText(`xl/worksheets/_rels/sheet${spec.sheetIdx1}.xml.rels`, buildSheetRelsForDrawing(drawingNo));
  });
}

// Row heights in Excel points, from a thumbnail's pixel height. Excel rows are
// measured in pt (1 pt ≈ 1.333 px at 96 dpi); pad slightly so the image does not
// butt against the cell border.
function rowHeightsFor(positions) {
  const out = new Map();
  for (const t of positions) {
    out.set(t.rowNum, Math.max(18, Math.round((t.height + 6) * 0.75)));
  }
  return out;
}

// ── Inventory → sheet rows ─────────────────────────────────────────────
// When `thumbnails` is a non-empty Map<shotId, {bytes, width, height}>, we
// prepend a "Preview" column as column A and return an extra `thumbPositions`
// array that buildInventoryXlsx uses to emit the OOXML drawing part. The
// Pages sheet is then responsible for setting the `rowHeights` option on
// buildSheet so the images have room to render.
// Friendly per-page scan outcome for the Pages sheets — mirrors the on-screen
// Status pill. Handles both shapes: the classic report's pagesRows (numeric
// `violations`, string `status`/`error`) and inventory page objects (nested
// `audit.violations`, `error`).
function pageOutcome(p) {
  if (p.error || p.status === "failed") return "Unreachable";
  const violations = Array.isArray(p.audit?.violations)
    ? p.audit.violations.length
    : (Number(p.violations) || 0);
  return violations > 0 ? "Issues" : "Clean";
}

function buildPagesSheet(inventory, thumbnails = null) {
  const header = [
    "URL", "Outcome", "Title", "Template ID", "URL Cluster", "Depth", "Source",
    "Page Type", "SPA Markers", "Is SPA",
    "Violations", "Incomplete", "Passes", "Inapplicable", "Screenshot",
    "html lang", "Visible Text Length",
    "Forms", "Inputs", "Required", "File Inputs", "Password Inputs", "OTP Inputs",
    "Data Tables", "Videos", "Audios", "YouTube", "Vimeo", "Captions",
    "Iframes", "Embeds", "SVGs",
    "Modals", "Carousels", "Tabs", "Menus", "Accordions", "Tooltips", "Datepickers", "Dropdowns",
    "Navs", "Main Landmarks", "Skip Links", "Breadcrumbs",
    "PDF Links", "Doc Links", "External Links",
    "Images", "Images w/o alt", "Decorative Images", "BG Images",
    "Elements w/ lang", "Shadow Roots",
    "H1", "H2", "H3", "H4", "H5", "H6", "Heading Skips",
    "Has Login", "Has CAPTCHA"
  ];
  const wantThumbs = thumbnails instanceof Map && thumbnails.size > 0;
  const rows = [wantThumbs ? ["Preview", ...header] : [...header]];
  const thumbPositions = []; // { rowNum1Indexed, shotId, width, height }

  for (const p of inventory.pages) {
    if (p.error) {
      const base = [
        p.url, pageOutcome(p), "(error)", p.template_id || "", p.url_cluster || "",
        p.depth ?? "", p.source || "", "", "", "", "", "", "", "", "No",
        ...Array.from({ length: 47 }, () => "")
      ];
      rows.push(wantThumbs ? ["", ...base] : base);
      continue;
    }
    const c = p.counts || {};
    const f = p.flags || {};
    const a = p.audit || {};
    const base = [
      p.url, pageOutcome(p), p.title || "", p.template_id || "", p.url_cluster || "",
      p.depth ?? "", p.source || "",
      p.pageType || "unknown", (p.spaMarkers || []).join(", "), f.isSPA ? "Yes" : "No",
      (a.violations || []).length, (a.incomplete || []).length,
      (a.passes || []).length, (a.inapplicable || []).length,
      p.screenshot?.id ? "Yes" : "No",
      p.htmlLang || "", p.visibleTextLength ?? 0,
      c.forms ?? 0, c.inputs ?? 0, c.requiredInputs ?? 0, c.fileInputs ?? 0, c.passwordInputs ?? 0, c.otpInputs ?? 0,
      c.dataTables ?? 0, c.videos ?? 0, c.audios ?? 0, c.youtube ?? 0, c.vimeo ?? 0, f.hasCaptions ? "Yes" : "No",
      c.iframes ?? 0, c.embeds ?? 0, c.svgs ?? 0,
      c.modals ?? 0, c.carousels ?? 0, c.tabs ?? 0, c.menus ?? 0, c.accordions ?? 0, c.tooltips ?? 0, c.datepickers ?? 0, c.dropdowns ?? 0,
      c.navs ?? 0, c.mainLandmarks ?? 0, c.skipLinks ?? 0, c.breadcrumbs ?? 0,
      c.pdfLinks ?? 0, c.docLinks ?? 0, c.externalLinks ?? 0,
      c.images ?? 0, c.imagesNoAlt ?? 0, c.decorativeImages ?? 0, c.bgImages ?? 0,
      c.elemsWithLang ?? 0, c.shadowRoots ?? 0,
      c.h1 ?? 0, c.h2 ?? 0, c.h3 ?? 0, c.h4 ?? 0, c.h5 ?? 0, c.h6 ?? 0, c.headingSkips ?? 0,
      f.hasLogin ? "Yes" : "No", f.hasCaptcha ? "Yes" : "No"
    ];
    if (wantThumbs) {
      rows.push(["", ...base]);
      const thumb = p.screenshot?.id ? thumbnails.get(p.screenshot.id) : null;
      if (thumb) {
        thumbPositions.push({
          rowNum: rows.length, // 1-indexed row number this page landed on
          shotId: p.screenshot.id,
          width: thumb.width,
          height: thumb.height
        });
      }
    } else {
      rows.push(base);
    }
  }
  return { rows, thumbPositions };
}

// Form-fields breakdown sheet — one row per (page, form, field). Auditors
// live in this sheet; it's where "actual component values" materialise.
function buildFormFieldsSheet(inventory) {
  const rows = [[
    "URL", "Page Title", "Form #", "Form Name/Action",
    "Field Name", "Field Type", "Field Label", "Required", "Autocomplete"
  ]];
  for (const p of inventory.pages) {
    if (p.error) continue;
    const forms = p.components?.forms || [];
    forms.forEach((form, fi) => {
      const formMeta = form.name || form.action || `form-${fi + 1}`;
      for (const f of (form.fields || [])) {
        rows.push([
          p.url, p.title || "", fi + 1, formMeta,
          f.name || "", f.type || "", f.label || "",
          f.required ? "Yes" : "No", f.autocomplete || ""
        ]);
      }
    });
  }
  return rows;
}

// Component inventory sheet — modal titles, tab labels, menu items, table
// captions/column headers. One row per component.
function buildComponentsSheet(inventory) {
  const rows = [[
    "URL", "Component Type", "Label / Title", "Detail"
  ]];
  for (const p of inventory.pages) {
    if (p.error) continue;
    const co = p.components || {};
    for (const m of (co.modals || [])) {
      rows.push([p.url, "Modal", m.label || "(no label)", m.role ? `role=${m.role}` : ""]);
    }
    for (const t of (co.tabs || [])) {
      rows.push([p.url, "Tab", t.label || "(no label)", t.selected ? "selected" : ""]);
    }
    for (const mi of (co.menuItems || [])) {
      rows.push([p.url, "MenuItem", mi.label || "(no text)", mi.href || ""]);
    }
    (co.carousels || []).forEach((c, i) => {
      rows.push([
        p.url, `Carousel #${i + 1}`, `${c.slideCount ?? 0} slide(s)`,
        (c.slideHeadings || []).join(" · ")
      ]);
    });
    for (const tb of (co.tables || [])) {
      rows.push([
        p.url, "DataTable", tb.caption || "(no caption)",
        `cols: ${(tb.columnHeaders || []).join(", ")}${tb.rowCount ? ` · rows: ${tb.rowCount}` : ""}`
      ]);
    }
    for (const b of (co.buttons || [])) {
      rows.push([p.url, "Button", b.label || "", b.disabled ? "disabled" : ""]);
    }
  }
  return rows;
}

// Violations sheet — one row per (page, violation rule, node). Auditors need
// this granular; it's the actual work-list. Mirrors the Findings UI's
// Compliance / Standards / Success Criteria decode so auditors don't have
// to mentally parse raw axe tags.
// Flatten a node's any/all/none check arrays into one human-readable string so
// the Excel carries the full per-node axe detail (the deepest level axe
// exposes — each check's message), not just the rule-level summary.
function checkSummary(n) {
  const parts = [];
  for (const slot of ["any", "all", "none"]) {
    for (const c of (n[slot] || [])) {
      if (c && c.message) parts.push(`[${slot}] ${c.message}`);
    }
  }
  return parts.join(" | ");
}

// Violations is the sheet auditors actually work in, so the element preview
// belongs on the finding's own row. The dedicated "Issue Screenshots" sheet
// stays as well — it carries Impact / Success Criteria context and enforces the
// MAX_ISSUE_SHOTS cap, which an inline column can't. Without the inline column
// the reader has to switch sheets and re-match by URL + Target selector.
//
// Mirrors buildPagesSheet's contract: with a non-empty `thumbnails` Map, prepend
// a "Preview" column as column A and return { rows, thumbPositions } so
// buildInventoryXlsx can emit the OOXML drawing part; otherwise thumbPositions
// comes back empty and the sheet is shaped exactly as before.
function buildViolationsSheet(inventory, thumbnails = null) {
  const header = [
    "URL", "Rule ID", "Impact",
    "Compliance", "Standards", "Success Criteria",
    "Description", "Help", "Help URL",
    "Target Selector", "XPath", "Ancestry",
    "Failure Summary", "HTML", "Checks (any/all/none)"
  ];
  const wantThumbs = thumbnails instanceof Map && thumbnails.size > 0;
  const rows = [wantThumbs ? ["Preview", ...header] : [...header]];
  const thumbPositions = []; // { rowNum, shotId, width, height }

  for (const p of inventory.pages) {
    if (p.error) continue;
    for (const v of (p.audit?.violations || [])) {
      const derived = deriveFromTags(v.tags || []);
      const nodes = v.nodes || [];
      if (!nodes.length) {
        const base = [
          p.url, v.ruleId || v.id || "", v.impact || "",
          derived.compliance, derived.standards, derived.successCriteria,
          v.description || "", v.help || "", v.helpUrl || "",
          "", "", "", "", "", ""
        ];
        rows.push(wantThumbs ? ["", ...base] : base);
        continue;
      }
      for (const n of nodes) {
        const base = [
          p.url, v.ruleId || v.id || "", v.impact || "",
          derived.compliance, derived.standards, derived.successCriteria,
          v.description || "", v.help || "", v.helpUrl || "",
          (n.target || []).join(" "),
          (n.xpath || []).join(" "),
          (n.ancestry || []).join(" "),
          n.failureSummary || "",
          n.html || "",
          checkSummary(n)
        ];
        rows.push(wantThumbs ? ["", ...base] : base);
        if (wantThumbs) {
          const t = n.elementShotId ? thumbnails.get(n.elementShotId) : null;
          if (t) {
            thumbPositions.push({
              rowNum: rows.length, shotId: n.elementShotId,
              width: t.width, height: t.height
            });
          }
        }
      }
    }
  }
  return { rows, thumbPositions };
}

// Generic per-category sheet (passes / incomplete / inapplicable) mirroring the
// Violations sheet columns, so the Excel carries the FULL four-category axe
// output — not just violations. Inapplicable rules usually have no nodes; the
// no-node branch still emits a row so the rule is recorded. Note: the Passes
// sheet can be large (one row per passing node across every page).
function buildResultCategorySheet(inventory, category) {
  const rows = [[
    "URL", "Rule ID", "Impact",
    "Compliance", "Standards", "Success Criteria",
    "Description", "Help", "Help URL",
    "Target Selector", "XPath", "Ancestry",
    "Failure Summary", "HTML", "Checks (any/all/none)"
  ]];
  for (const p of inventory.pages) {
    if (p.error) continue;
    for (const r of (p.audit?.[category] || [])) {
      const derived = deriveFromTags(r.tags || []);
      const nodes = r.nodes || [];
      if (!nodes.length) {
        rows.push([
          p.url, r.ruleId || r.id || "", r.impact || "",
          derived.compliance, derived.standards, derived.successCriteria,
          r.description || "", r.help || "", r.helpUrl || "",
          "", "", "", "", "", ""
        ]);
        continue;
      }
      for (const n of nodes) {
        rows.push([
          p.url, r.ruleId || r.id || "", r.impact || "",
          derived.compliance, derived.standards, derived.successCriteria,
          r.description || "", r.help || "", r.helpUrl || "",
          (n.target || []).join(" "),
          (n.xpath || []).join(" "),
          (n.ancestry || []).join(" "),
          n.failureSummary || "",
          n.html || "",
          checkSummary(n)
        ]);
      }
    }
  }
  return rows;
}

// Scan-environment sheet — one row per page with axe's run metadata (engine,
// runner, environment, tool options, timestamp). This is the rest of what axe
// returns beyond the four result categories, so the Excel carries the complete
// axe output, not just findings.
function buildEnvironmentSheet(inventory) {
  const rows = [[
    "URL", "Page Title", "Scan Started", "Duration (ms)",
    "axe Engine", "axe Version", "Test Runner",
    "User Agent", "Window Width", "Window Height",
    "Orientation", "axe Timestamp", "Tool Options"
  ]];
  for (const p of inventory.pages || []) {
    if (p.error) {
      rows.push([p.url, p.title || "", "", "", "", "", "", "", "", "", "", "", `ERROR: ${p.error}`]);
      continue;
    }
    const a = p.audit || {};
    const eng = a.testEngine || {};
    const env = a.testEnvironment || {};
    rows.push([
      p.url, p.title || "",
      a.scanStartedAt || "", a.scanDurationMs ?? "",
      eng.name || "", eng.version || "",
      (a.testRunner && a.testRunner.name) || "",
      env.userAgent || "", env.windowWidth ?? "", env.windowHeight ?? "",
      env.orientationType || (env.orientationAngle != null ? String(env.orientationAngle) : ""),
      a.axeTimestamp || "",
      a.toolOptions ? JSON.stringify(a.toolOptions) : ""
    ]);
  }
  return rows;
}

function buildTemplatesSheet(inventory) {
  const rows = [[
    "Template ID", "URL Cluster", "Page Count", "Sample URL", "Sample Page Type",
    "Is SPA", "SPA Markers",
    "Total Violations", "Total Incomplete", "Total Passes",
    "Has Forms", "Has Data Tables", "Has Video", "Has Audio",
    "Has Iframes", "Has Modals", "Has Carousels", "Has Tabs",
    "Has Menus", "Has Accordions", "Has Datepickers", "Has Dropdowns",
    "Has PDF Links", "Has Login", "Has CAPTCHA", "Has Shadow DOM",
    "Content Signal Summary"
  ]];
  for (const t of inventory.templates) {
    const f = t.flags || {};
    rows.push([
      t.template_id, t.url_cluster, t.page_count, t.sample_url,
      t.sample_pageType || "unknown",
      t.isSPA ? "Yes" : "No", (t.sample_spaMarkers || []).join(", "),
      t.totalViolations ?? 0, t.totalIncomplete ?? 0, t.totalPasses ?? 0,
      f.hasForms ? "Yes" : "No", f.hasDataTable ? "Yes" : "No",
      f.hasVideo ? "Yes" : "No", f.hasAudio ? "Yes" : "No",
      f.hasIframe ? "Yes" : "No", f.hasModal ? "Yes" : "No",
      f.hasCarousel ? "Yes" : "No", f.hasTabs ? "Yes" : "No",
      f.hasMenu ? "Yes" : "No", f.hasAccordion ? "Yes" : "No",
      f.hasDatepicker ? "Yes" : "No", f.hasDropdown ? "Yes" : "No",
      f.hasPdfLinks ? "Yes" : "No", f.hasLogin ? "Yes" : "No",
      f.hasCaptcha ? "Yes" : "No", f.hasShadowDom ? "Yes" : "No",
      t.contentSignalSummary || ""
    ]);
  }
  return rows;
}

function buildProposedSampleSheet(inventory) {
  const rows = [["#", "URL", "Template ID", "URL Cluster", "Reason", "Estimated Manual Tests"]];
  inventory.proposedSample.forEach((s, i) => {
    rows.push([i + 1, s.url, s.template_id, s.url_cluster || "", s.reason || "Template representative", s.testCount ?? 0]);
  });
  return rows;
}

// Executive overview sheet — the first thing any reader sees. Sections
// laid out top-to-bottom: crawl metadata, audit totals, impact breakdown,
// top 10 rules by frequency (widest ROI for fixing), top 10 pages by
// violation count (prioritise remediation). No auto-filter since the
// layout mixes 2-col key/value blocks with multi-col tables.
function buildOverviewSheet(inventory) {
  const rows = [];
  const m = inventory.meta || {};
  const a = inventory.corpusAudit || {};

  // ── Title ──
  rows.push(["EnableUser Accessibility Inventory"]);
  rows.push([""]);

  // ── Crawl Metadata ──
  rows.push(["Crawl Metadata"]);
  rows.push(["Seed URL", m.seedUrl || ""]);
  rows.push(["Seed Host", m.seedHost || ""]);
  rows.push(["Profile", m.profile || ""]);
  rows.push(["Max URLs", m.maxUrls ?? ""]);
  rows.push(["Crawl Depth", m.crawlDepthLabel || m.crawlDepth || ""]);
  rows.push(["Generated", m.generatedAt || ""]);
  rows.push([""]);

  // ── Audit Totals ──
  rows.push(["Audit Totals"]);
  rows.push(["Pages Audited", a.pagesAudited ?? 0]);
  rows.push(["Pages With Screenshots", a.pagesScreenshotted ?? 0]);
  rows.push(["Templates Detected", (inventory.templates || []).length]);
  rows.push(["Proposed Audit Sample", (inventory.proposedSample || []).length]);
  rows.push(["Violations", a.violations ?? 0]);
  rows.push(["Incomplete", a.incomplete ?? 0]);
  rows.push(["Passes", a.passes ?? 0]);
  rows.push(["Inapplicable", a.inapplicable ?? 0]);
  rows.push([""]);

  // ── Impact Breakdown ──
  const impactCounts = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  let pagesWithViolations = 0;
  // Aggregate rule and per-page stats while we walk violations once.
  const ruleAgg = new Map(); // ruleId → { impact, instances, pages:Set, help }
  const pageAgg = new Map(); // url → { violations, incomplete, template }
  for (const p of inventory.pages || []) {
    if (p.error) continue;
    const vc = (p.audit?.violations || []).reduce((n, v) => n + (v.nodes?.length || 1), 0);
    const ic = (p.audit?.incomplete || []).length;
    if (vc > 0) pagesWithViolations++;
    pageAgg.set(p.url, { violations: vc, incomplete: ic, template: p.template_id || "" });
    for (const v of (p.audit?.violations || [])) {
      const impact = (v.impact || "").toLowerCase();
      if (impactCounts[impact] !== undefined) {
        impactCounts[impact] += (v.nodes?.length || 1);
      }
      const ruleId = v.ruleId || v.id || "(unknown)";
      if (!ruleAgg.has(ruleId)) {
        ruleAgg.set(ruleId, {
          impact: v.impact || "",
          instances: 0,
          pages: new Set(),
          help: v.help || v.description || ""
        });
      }
      const r = ruleAgg.get(ruleId);
      r.instances += (v.nodes?.length || 1);
      r.pages.add(p.url);
    }
  }

  rows.push(["Impact Breakdown (violation instances)"]);
  rows.push(["Critical", impactCounts.critical]);
  rows.push(["Serious", impactCounts.serious]);
  rows.push(["Moderate", impactCounts.moderate]);
  rows.push(["Minor", impactCounts.minor]);
  rows.push(["Pages With At Least One Violation", pagesWithViolations]);
  rows.push([""]);

  // ── Top 10 Rules by Frequency ──
  const topRules = [...ruleAgg.entries()]
    .sort((a, b) => b[1].instances - a[1].instances)
    .slice(0, 10);
  rows.push(["Top 10 Rules by Frequency"]);
  rows.push(["Rule ID", "Impact", "Pages Affected", "Total Instances", "Description"]);
  for (const [ruleId, info] of topRules) {
    rows.push([ruleId, info.impact, info.pages.size, info.instances, info.help]);
  }
  if (!topRules.length) rows.push(["(no violations detected)"]);
  rows.push([""]);

  // ── Top 10 Pages by Violation Count ──
  const topPages = [...pageAgg.entries()]
    .filter(([, v]) => v.violations > 0)
    .sort((a, b) => b[1].violations - a[1].violations)
    .slice(0, 10);
  rows.push(["Top 10 Pages by Violation Count"]);
  rows.push(["URL", "Violations", "Incomplete", "Template ID"]);
  for (const [url, info] of topPages) {
    rows.push([url, info.violations, info.incomplete, info.template]);
  }
  if (!topPages.length) rows.push(["(no pages with violations)"]);

  return rows;
}

function buildTestMatrixSheet(inventory) {
  // Rows = templates. Cols = union of manual tests across all templates.
  const testSet = new Set();
  for (const t of inventory.templates) {
    for (const r of (t.recommendedTests || [])) testSet.add(r.test);
  }
  const testList = [...testSet];
  const rows = [["Template ID", "URL Cluster", "Sample URL", ...testList]];
  for (const t of inventory.templates) {
    const have = new Set((t.recommendedTests || []).map(r => r.test));
    rows.push([
      t.template_id, t.url_cluster, t.sample_url,
      ...testList.map(test => have.has(test) ? "Required" : "N/A")
    ]);
  }
  return rows;
}

// Clusters workbook — one sheet per URL cluster, plus a summary sheet at the
// front. Pages are grouped by `url_cluster`; a template can span multiple
// clusters, so this is not the same as buildTemplatesSheet.
function sanitizeSheetName(name, used) {
  // Excel forbids: \ / ? * [ ] : — and caps at 31 chars. Also can't be empty
  // or equal "History" (reserved).
  let n = String(name || "").replace(/[\\\/\?\*\[\]:]/g, "-").trim();
  if (!n) n = "cluster";
  if (n.length > 31) n = n.slice(0, 31);
  if (/^history$/i.test(n)) n = n + "-";
  let candidate = n;
  let i = 2;
  while (used.has(candidate.toLowerCase())) {
    const suffix = `-${i++}`;
    const base = n.slice(0, 31 - suffix.length);
    candidate = base + suffix;
  }
  used.add(candidate.toLowerCase());
  return candidate;
}

function buildClusterSheet(pages) {
  const rows = [[
    "URL", "Title", "Template ID", "Depth", "Source",
    "Violations", "Incomplete", "Passes",
    "Forms", "Tables", "Modals", "Carousels", "PDF Links",
    "Login", "Screenshot"
  ]];
  for (const p of pages) {
    if (p.error) {
      rows.push([
        p.url, "(error)", p.template_id || "", p.depth ?? "", p.source || "",
        "", "", "", "", "", "", "", "", "No", "No"
      ]);
      continue;
    }
    const c = p.counts || {};
    const f = p.flags || {};
    const a = p.audit || {};
    rows.push([
      p.url, p.title || "", p.template_id || "", p.depth ?? "", p.source || "",
      (a.violations || []).length, (a.incomplete || []).length, (a.passes || []).length,
      c.forms ?? 0, c.dataTables ?? c.tables ?? 0, c.modals ?? 0, c.carousels ?? 0,
      c.pdfLinks ?? 0,
      f.hasLogin ? "Yes" : "No",
      p.screenshot?.id ? "Yes" : "No"
    ]);
  }
  return rows;
}

function buildClustersSummarySheet(clusterEntries) {
  const rows = [["#", "URL Cluster", "Sheet Name", "Page Count", "Distinct Templates", "Total Violations", "Sample URL"]];
  clusterEntries.forEach((c, i) => {
    rows.push([
      i + 1, c.cluster, c.sheetName, c.pages.length,
      c.templateIds.size, c.totalViolations, c.pages[0]?.url || ""
    ]);
  });
  return rows;
}

export async function buildClustersXlsx(inventory) {
  // Group pages by url_cluster. Preserve the cluster order in which templates
  // appear (so the summary sheet mirrors the UI's Templates ordering).
  const byCluster = new Map();
  const clusterOrder = [];
  for (const t of inventory.templates || []) {
    const key = t.url_cluster || "(unknown)";
    if (!byCluster.has(key)) {
      byCluster.set(key, { cluster: key, pages: [], templateIds: new Set(), totalViolations: 0 });
      clusterOrder.push(key);
    }
  }
  for (const p of inventory.pages || []) {
    const key = p.url_cluster || "(unknown)";
    if (!byCluster.has(key)) {
      byCluster.set(key, { cluster: key, pages: [], templateIds: new Set(), totalViolations: 0 });
      clusterOrder.push(key);
    }
    const entry = byCluster.get(key);
    entry.pages.push(p);
    if (p.template_id) entry.templateIds.add(p.template_id);
    entry.totalViolations += (p.audit?.violations || []).length;
  }

  const usedNames = new Set();
  usedNames.add("summary");
  const clusterEntries = clusterOrder.map(key => {
    const entry = byCluster.get(key);
    entry.sheetName = sanitizeSheetName(key, usedNames);
    return entry;
  });

  const CLUSTERS_SUMMARY_WIDTHS = [5, 30, 25, 12, 18, 15, 55];
  const CLUSTER_PAGE_WIDTHS = [55, 35, 15, 8, 10, 12, 12, 10, 8, 8, 8, 10, 10, 8, 12];

  const ss = createSharedStrings();
  const sheets = [
    { name: "Summary", rows: buildClustersSummarySheet(clusterEntries), colWidths: CLUSTERS_SUMMARY_WIDTHS },
    ...clusterEntries.map(c => ({
      name: c.sheetName,
      rows: buildClusterSheet(c.pages),
      colWidths: CLUSTER_PAGE_WIDTHS
    }))
  ];
  const sheetXmls = sheets.map(s => buildSheet(s.rows, ss, { colWidths: s.colWidths }));

  const z = createZip();
  z.addText("[Content_Types].xml", buildContentTypes(sheets.length));
  z.addText("_rels/.rels", buildRootRels());
  z.addText("xl/workbook.xml", buildWorkbook(sheets.map(s => s.name)));
  z.addText("xl/_rels/workbook.xml.rels", buildWorkbookRels(sheets.length));
  z.addText("xl/styles.xml", buildStyles());
  sheetXmls.forEach((xml, i) => z.addText(`xl/worksheets/sheet${i + 1}.xml`, xml));
  z.addText("xl/sharedStrings.xml", ss.xml());
  return z.finalize("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

// ── Audit Report workbook ──────────────────────────────────────────────
// One sheet per URL, preceded by a Summary sheet. Rows on each URL sheet
// mirror the Findings tab UI: one row per (rule, node) with columns
// Rule · Impact · Target · Compliance · Standards · Success Criteria ·
// Code Snippet · Failure Summary · Help.

function auditSheetNameFromUrl(url, used) {
  let label;
  try {
    const u = new URL(url);
    const path = u.pathname && u.pathname !== "/" ? u.pathname : "-home";
    label = (u.hostname + path).replace(/^www\./, "");
  } catch {
    label = url || "page";
  }
  return sanitizeSheetName(label, used);
}

function buildAuditPageSheet(findings) {
  const rows = [[
    "Rule ID", "Rule Impact", "Node Impact", "WCAG Tags",
    "Compliance", "Standards", "Success Criteria",
    "Description", "Help", "Help URL",
    "Target Selector", "XPath", "Ancestry",
    "HTML", "Failure Summary", "Checks (any/all/none)"
  ]];
  for (const f of findings) {
    rows.push([
      f.ruleId || "", f.impact || "", f.nodeImpact || "", f.tags || "",
      f.compliance, f.standards, f.successCriteria,
      f.description || "", f.help || "", f.helpUrl || "",
      f.target || "", f.xpath || "", f.ancestry || "",
      f.html || "", f.failureSummary || "", f.checks || ""
    ]);
  }
  return rows;
}

// Combined report — every (url, rule, node) finding across the crawl on a
// single sheet. Mirrors the per-URL sheet columns; prepends URL so the
// reader can tell which page each row belongs to.
function buildCombinedReportSheet(pageEntries) {
  const rows = [[
    "URL", "Rule ID", "Rule Impact", "Node Impact", "WCAG Tags",
    "Compliance", "Standards", "Success Criteria",
    "Description", "Help", "Help URL",
    "Target Selector", "XPath", "Ancestry",
    "HTML", "Failure Summary", "Checks (any/all/none)"
  ]];
  for (const e of pageEntries) {
    for (const f of e.findings) {
      rows.push([
        e.url, f.ruleId || "", f.impact || "", f.nodeImpact || "", f.tags || "",
        f.compliance, f.standards, f.successCriteria,
        f.description || "", f.help || "", f.helpUrl || "",
        f.target || "", f.xpath || "", f.ancestry || "",
        f.html || "", f.failureSummary || "", f.checks || ""
      ]);
    }
  }
  return rows;
}

function collectFindingsForPage(page, category = "violations") {
  const findings = [];
  if (page.error) return findings;
  for (const v of (page.audit?.[category] || [])) {
    const derived = deriveFromTags(v.tags || []);
    const nodes = v.nodes && v.nodes.length ? v.nodes : [{}];
    for (const n of nodes) {
      findings.push({
        ruleId: v.ruleId || v.id || "",
        impact: (v.impact || "").toLowerCase(),
        nodeImpact: n.impact || "",
        tags: (v.tags || []).join(" "),
        target: (n.target || []).join(" "),
        xpath: (n.xpath || []).join(" "),
        ancestry: (n.ancestry || []).join(" "),
        html: n.html || "",
        failureSummary: n.failureSummary || "",
        description: v.description || "",
        help: v.help || "",
        helpUrl: v.helpUrl || "",
        checks: checkSummary(n),
        compliance: derived.compliance,
        standards: derived.standards,
        successCriteria: derived.successCriteria
      });
    }
  }
  // Sort by impact severity within a page.
  const impactOrder = { critical: 0, serious: 1, moderate: 2, minor: 3, "": 4 };
  findings.sort((a, b) => {
    const ia = impactOrder[a.impact] ?? 5;
    const ib = impactOrder[b.impact] ?? 5;
    if (ia !== ib) return ia - ib;
    return a.ruleId.localeCompare(b.ruleId);
  });
  return findings;
}

// ── Single / Multi-page scan-report workbook ───────────────────────────
// Consumes the `report` object buildReport() produces for SCAN_CURRENT /
// SCAN_MULTI (its rows are already flat), and projects each row set into its
// own sheet — the Excel equivalent of the multi-section CSV that DOWNLOAD_CSV
// emits, at full fidelity (incl. XPath/Ancestry and a readable Checks column).

// Flatten a flat issue/category row's check arrays (checks_any/all/none) into
// one readable string, matching the inventory sheet's Checks column.
function summarizeChecksFromRow(r) {
  const parts = [];
  for (const slot of ["checks_any", "checks_all", "checks_none"]) {
    for (const c of (r[slot] || [])) {
      if (c && c.message) parts.push(`[${slot.replace("checks_", "")}] ${c.message}`);
    }
  }
  return parts.join(" | ");
}

// Generic "array of row-objects → 2D sheet rows" with a header. Objects/arrays
// are JSON-stringified so non-scalar cells survive; buildSheet handles escaping
// and the 32k-char cap.
// objRowsToSheet with a leading Preview column carrying embedded screenshots.
// `shotKey` names the field on each row holding the shot id (elementShotId for
// findings, screenshot_id for pages). Rows whose shot is absent from the
// thumbnails map get an empty Preview cell rather than being skipped, so row
// order still matches the source data exactly.
//
// Returns { rows, thumbPositions }; with no usable thumbnails it degrades to the
// plain objRowsToSheet shape and an empty thumbPositions, so callers can pass a
// map unconditionally.
function objRowsToSheetWithPreview(headers, keys, rows, thumbnails, shotKey) {
  const wantThumbs = thumbnails instanceof Map && thumbnails.size > 0;
  if (!wantThumbs) return { rows: objRowsToSheet(headers, keys, rows), thumbPositions: [] };

  const out = [["Preview", ...headers]];
  const thumbPositions = [];
  for (const r of (rows || [])) {
    out.push(["", ...rowCells(keys, r)]);
    const id = r?.[shotKey];
    const t = id ? thumbnails.get(id) : null;
    if (t) thumbPositions.push({ rowNum: out.length, shotId: id, width: t.width, height: t.height });
  }
  return { rows: out, thumbPositions };
}

// One object → one array of cells, in `keys` order. Objects and arrays are
// JSON-stringified; null/undefined become empty strings.
function rowCells(keys, r) {
  return keys.map(k => {
    const v = r[k];
    if (v === null || v === undefined) return "";
    if (Array.isArray(v) || typeof v === "object") {
      try { return JSON.stringify(v); } catch { return String(v); }
    }
    return v;
  });
}

function objRowsToSheet(headers, keys, rows) {
  const out = [headers];
  for (const r of (rows || [])) out.push(rowCells(keys, r));
  return out;
}

// Workflow-mode timeline sheet. `workflow` is the session object background
// attaches to the report: { testId, startedAt, endedAt, pages[], steps[],
// counts, limitReached } (see lib/workflow.js).
function buildWorkflowSheet(workflow) {
  const rows = [["Step", "Action", "URL", "Page Title", "Detail / Clicked Element", "Scans", "New Issues", "Repeats", "Timestamp"]];
  for (const s of workflow.steps || []) {
    // Click steps may carry the control's value, the anchor's target, and
    // the click coordinates (v0.5.x richer click metadata) — surface all of
    // it in the Detail column so the workbook reader sees WHAT was clicked,
    // WHERE on the page, and where it led. Rows are chronological by
    // construction (session.steps appends in event order).
    const detail = [
      s.detail || "",
      s.value ? `value: "${s.value}"` : "",
      s.coordinates ? `@ (${s.coordinates.x}, ${s.coordinates.y})` : "",
      s.href ? `→ ${s.href}` : ""
    ].filter(Boolean).join("  ");
    rows.push([
      s.stepId, s.action, s.url, s.title || "", detail,
      s.scans || 0, s.newIssues || 0, Math.max(0, (s.totalIssues || 0) - (s.newIssues || 0)),
      s.timestamp || ""
    ]);
  }
  rows.push([]);
  const c = workflow.counts || {};
  rows.push([`Session ${workflow.testId}: ${workflow.pages?.length || 0} page(s), ${workflow.steps?.length || 0} step(s), ${c.scans || 0} scan(s), ${c.newIssues || 0} unique issue(s), ${c.suppressedDuplicates || 0} duplicate finding(s) suppressed by session-wide dedup.`]);
  rows.push([`Recorded ${workflow.startedAt || "?"} → ${workflow.endedAt || "?"}${workflow.limitReached ? " — STEP LIMIT REACHED (session capped)" : ""}.`]);
  rows.push(["Issue identity = hash(node html + selector + rule id + normalized page URL); a violation re-found on a later scan of the same page counts once."]);
  return rows;
}

// Guided Tests sheet (Phase C). `gt` is report.guidedTests: the stop-by-stop
// keyboard-walk record (with per-stop focus ground truth), trap findings,
// and the reflow measurement — the full evidence trail behind the guided
// findings in the Violations / Incomplete sheets.
function buildGuidedTestsSheet(gt) {
  const rows = [["#", "Record", "Element", "Selector", "Result", "Detail"]];
  if (gt.keyboard) {
    for (const s of gt.keyboard.stops || []) {
      const fc = s.focusCheck || {};
      const result = !fc.checked ? "unverified" : fc.visible ? "visible focus" : "NO VISIBLE FOCUS";
      const detail = !fc.checked
        ? (fc.reason || "")
        : (fc.changes || []).map(c => `${c.prop}: ${c.from} → ${c.to}`).join(" | ") || "no visible computed-style change under forced :focus/:focus-visible";
      rows.push([s.index, "Tab stop", s.tag || "", s.selector || "", result, detail]);
    }
    for (const f of gt.keyboard.findings || []) {
      rows.push(["", "Keyboard trap", "", f.selector || "", f.escaped ? "Escape freed focus" : "Escape did NOT free focus", "Focus stopped advancing for 3 consecutive Tab presses — review whether this is a designed modal with an advertised exit"]);
    }
    rows.push(["", "Walk end", "", "", gt.keyboard.cycled ? "focus order cycled" : gt.keyboard.trapped ? "STOPPED at unescapable trap" : "ended", `${(gt.keyboard.stops || []).length} tab stop(s) recorded`]);
  }
  if (gt.reflow) {
    rows.push(["", "Reflow @320px", "document", "", gt.reflow.horizontalScroll ? "HORIZONTAL SCROLL" : "reflows cleanly", `scrollWidth ${gt.reflow.scrollWidth}px vs clientWidth ${gt.reflow.clientWidth}px`]);
    for (const o of gt.reflow.offenders || []) {
      rows.push(["", "Overflow element", "", o.selector || "", `${Math.round(o.width)}px wide`, o.html || ""]);
    }
  }
  rows.push([]);
  rows.push([`Guided CDP tests on ${gt.url || "?"} at ${gt.generatedAt || "?"}. Keyboard: trusted Tab injection (Input.dispatchKeyEvent, 200 ms spacing), cycle-detected walk, trap guard with automatic Escape attempt. Focus ground truth: CSS.forcePseudoState(:focus,:focus-visible) computed-style diff — the browser's actual rendering, not CSSOM guessing. Reflow: Emulation.setDeviceMetricsOverride 320×900 (WCAG 1.4.10's normative width).`]);
  return rows;
}

// v0.4.4 — Broken Links sheet, shared by the report + inventory workbooks.
// One row per broken internal link target; "Found On" lists every crawled
// page that contained the link (with the anchor text used), so the operator
// can locate and fix the actual <a> tags.
const BROKEN_LINKS_HEADERS = ["Broken URL", "Problem", "Detail", "HTTP Status", "Redirects To", "Linked From (count)", "Found On (pages + link text)"];
const BROKEN_LINKS_KEYS = ["url", "classification", "detail", "status", "final_url", "source_count", "sources"];
const BROKEN_LINKS_WIDTHS = [55, 16, 45, 11, 45, 16, 90];

function buildBrokenLinksSheet(broken) {
  const rows = objRowsToSheet(BROKEN_LINKS_HEADERS, BROKEN_LINKS_KEYS, broken?.rows || []);
  // Summary lines below the data so autofilter on the header still works.
  rows.push([]);
  rows.push([`Checked ${broken?.checked ?? 0} of ${broken?.totalTargets ?? 0} unique internal link targets${broken?.truncated ? " (capped)" : ""}.`]);
  rows.push([`Site not-found behaviour: ${broken?.notFoundMode || "unknown"} (probe statuses: ${(broken?.probeStatuses || []).join(", ") || "n/a"}).`]);
  return rows;
}

// v0.4.5 — Manual Checklist sheet (team checklist v1.2, 129 cases). The
// crawler can't automate these SCs; instead every crawl workbook ships the
// full checklist with an "Applies To" column scoped by the components the
// crawler actually found (forms, modals, carousels, video, …), plus sample
// URLs to test on. Result/Notes columns left blank for the auditor.
const MANUAL_HEADERS = ["Test ID", "Pass", "SC", "Level", "What to verify", "How to test", "Pass criterion", "Why scanners miss it", "Applies To", "Sample URLs to test", "Machine assist (v0.4.6)", "Result", "Notes"];
const MANUAL_WIDTHS = [8, 22, 8, 6, 40, 55, 45, 45, 30, 55, 50, 10, 30];

function buildManualChecklistSheet(pages) {
  const rows = [MANUAL_HEADERS];
  for (const t of MANUAL_TESTS) {
    const app = testApplicability(t, pages || []);
    rows.push([
      t.id, t.pass, t.sc, t.level, t.verify, t.how, t.passCriterion, t.trap,
      app.label, app.urls.join("\n"), MACHINE_ASSIST[t.id] || "", "", ""
    ]);
  }
  rows.push([]);
  rows.push([`Manual Test Checklist v${MANUAL_CHECKLIST_VERSION} — ${MANUAL_TESTS.length} cases. "Applies To" is scoped by components the crawler detected; "All pages" tests should be run on the Proposed Sample.`]);
  rows.push([`"Machine assist" cases are pre-screened by the visual-state check suite — their findings appear in the Violations / Incomplete sheets under rule ids starting with "eu-". Review those findings first, then spot-check.`]);
  return rows;
}

// Multi-page report mode has no content-signal flags on its page rows —
// derive what we can from the media inventory (video/audio/PDF/iframe per
// page) so those manual tests still get scoped to the right URLs.
function pagesForManualChecklist(report) {
  const byUrl = new Map();
  for (const p of report.pagesRows || []) byUrl.set(p.url, { url: p.url });
  for (const m of report.mediaRows || []) {
    if (!m.url) continue;
    let page = byUrl.get(m.url);
    if (!page) { page = { url: m.url }; byUrl.set(m.url, page); }
    const fam = `${m.family || ""} ${m.kind || ""} ${m.subtype || ""}`.toLowerCase();
    if (fam.includes("video")) page.hasVideo = true;
    if (fam.includes("audio")) page.hasAudio = true;
    if (fam.includes("pdf") || fam.includes("office") || fam.includes("doc")) page.hasPdfLinks = true;
    if (fam.includes("iframe") || fam.includes("embed")) page.hasIframe = true;
  }
  return [...byUrl.values()];
}

// v0.4.5 — Scan Settings sheet: exactly what configuration produced this
// workbook, so nobody has to guess what was running.
function buildScanSettingsSheet(settings) {
  const rows = [["Setting", "Value"]];
  for (const [k, v] of Object.entries(settings || {})) {
    rows.push([k, (v === null || v === undefined) ? "" : String(v)]);
  }
  return rows;
}

// `thumbnails` is the same Map<shotId, {bytes,width,height}> the inventory
// workbook takes. Without it this produces exactly the pre-v0.5.0 workbook.
//
// The classic report previously carried no imagery at all, so reprojecting a
// crawl through "Open Classic Report" and exporting from there silently dropped
// every screenshot the crawl had captured — the same evidence the inventory
// workbook showed. Violations gets the per-element crop on the finding's own
// row; Pages gets the full-page shot.
export async function buildReportXlsx(report, { thumbnails = null } = {}) {
  const ss = createSharedStrings();
  const wantThumbs = thumbnails instanceof Map && thumbnails.size > 0;
  const PREVIEW_WIDTH = 44;
  const withChecks = (rows) => (rows || []).map(r => ({ ...r, checks_summary: summarizeChecksFromRow(r) }));

  const CATEGORY_HEADERS = ["URL", "Page Title", "Category", "Rule ID", "Rule Impact", "Description", "Help", "Help URL", "Tags", "Node Impact", "Target", "XPath", "Ancestry", "HTML", "Failure Summary", "Checks (any/all/none)"];
  const CATEGORY_KEYS = ["url", "page_title", "category", "rule_id", "rule_impact", "rule_description", "rule_help", "rule_help_url", "rule_tags", "node_impact", "node_target", "node_xpath", "node_ancestry", "node_html", "node_failure_summary", "checks_summary"];
  const CATEGORY_WIDTHS = [50, 30, 12, 20, 12, 40, 30, 30, 26, 12, 35, 35, 35, 50, 40, 40];

  const VIOLATIONS_HEADERS = ["URL", "Page Title", "WCAG", "Level", "SC Name", "IS 17802", "EN 301 549", "Section 508", "ADA", "Rule ID", "Source", "Rule Impact", "Description", "Help", "Tags", "Node Impact", "Target", "XPath", "Ancestry", "HTML", "Failure Summary", "Help URL", "Checks (any/all/none)"];
  const VIOLATIONS_KEYS = ["url", "page_title", "wcag_criterion", "wcag_level", "wcag_name", "is17802_clause", "en301549_clause", "section508_ref", "ada_ref", "rule_id", "rule_source", "rule_impact", "rule_description", "rule_help", "rule_tags", "impact", "selector", "xpath", "ancestry", "html_snippet", "failure_summary", "help_url", "checks_summary"];
  const VIOLATIONS_WIDTHS = [50, 30, 10, 8, 28, 22, 22, 28, 28, 20, 10, 12, 40, 30, 28, 12, 35, 35, 35, 50, 40, 30, 40];

  const REPORT_PAGES_HEADERS = ["URL", "Title", "Depth", "Source", "Status", "Outcome", "Violations", "Passes", "Incomplete", "Inapplicable", "Template ID", "URL Cluster", "axe Version", "Error"];
  const REPORT_PAGES_KEYS = ["url", "page_title", "depth", "source", "status", "outcome", "violations", "passes", "incomplete", "inapplicable", "template_id", "url_cluster", "axe_version", "error"];
  const REPORT_PAGES_WIDTHS = [50, 30, 7, 10, 9, 12, 11, 9, 11, 12, 16, 20, 11, 30];

  // Built eagerly so the thumbnail row positions are known before the drawing
  // parts are emitted below. issueRows carry elementShotId (set in buildReport);
  // pagesRows carry screenshot_id.
  const violationsBuild = objRowsToSheetWithPreview(
    VIOLATIONS_HEADERS, VIOLATIONS_KEYS, withChecks(report.issueRows), thumbnails, "elementShotId"
  );
  const reportPagesBuild = objRowsToSheetWithPreview(
    REPORT_PAGES_HEADERS, REPORT_PAGES_KEYS,
    (report.pagesRows || []).map(p => ({ ...p, outcome: pageOutcome(p) })),
    thumbnails, "screenshot_id"
  );

  const sheets = [
    {
      name: "WCAG Summary",
      rows: objRowsToSheet(
        ["Criterion", "Level", "Name", "Status", "Pages Passed", "Pages Failed", "Total Violations"],
        ["wcag_criterion", "level", "name", "status", "pages_passed", "pages_failed", "total_violations"],
        report.summaryRows
      ),
      colWidths: [12, 8, 34, 10, 13, 13, 16]
    },
    {
      name: "Conformance by Standard",
      rows: objRowsToSheet(
        ["Profile", "Label", "Applicable SCs", "Passed", "Failed", "Violations", "Conformance"],
        ["profile_key", "profile_label", "applicable_criteria", "passed_criteria", "failed_criteria", "total_violations", "conformance_status"],
        report.profilesRows
      ),
      colWidths: [14, 34, 14, 10, 10, 12, 32]
    },
    {
      name: "Violations",
      rows: violationsBuild.rows,
      colWidths: violationsBuild.thumbPositions.length
        ? [PREVIEW_WIDTH, ...VIOLATIONS_WIDTHS]
        : VIOLATIONS_WIDTHS,
      opts: {
        freezeFirstCol: true,
        rowHeights: rowHeightsFor(violationsBuild.thumbPositions),
        drawingRelId: violationsBuild.thumbPositions.length ? "rId1" : null
      }
    },
    { name: "Passes", rows: objRowsToSheet(CATEGORY_HEADERS, CATEGORY_KEYS, withChecks(report.passRows)), colWidths: CATEGORY_WIDTHS, opts: { freezeFirstCol: true } },
    { name: "Incomplete", rows: objRowsToSheet(CATEGORY_HEADERS, CATEGORY_KEYS, withChecks(report.incompleteRows)), colWidths: CATEGORY_WIDTHS, opts: { freezeFirstCol: true } },
    { name: "Inapplicable", rows: objRowsToSheet(CATEGORY_HEADERS, CATEGORY_KEYS, withChecks(report.inapplicableRows)), colWidths: CATEGORY_WIDTHS, opts: { freezeFirstCol: true } },
    {
      name: "Pages",
      rows: reportPagesBuild.rows,
      colWidths: reportPagesBuild.thumbPositions.length
        ? [PREVIEW_WIDTH, ...REPORT_PAGES_WIDTHS]
        : REPORT_PAGES_WIDTHS,
      opts: {
        freezeFirstCol: true,
        rowHeights: rowHeightsFor(reportPagesBuild.thumbPositions),
        drawingRelId: reportPagesBuild.thumbPositions.length ? "rId1" : null
      }
    },
    {
      name: "Templates",
      rows: objRowsToSheet(
        ["Template ID", "URL Cluster", "Pages", "Sample URL", "Sample Title", "Total Violations", "Critical", "Serious", "Moderate", "Minor", "Unique Rules"],
        ["template_id", "url_cluster", "page_count", "sample_url", "sample_title", "total_violations", "critical", "serious", "moderate", "minor", "unique_rules"],
        report.templatesRows
      ),
      colWidths: [16, 20, 8, 50, 30, 14, 9, 9, 10, 8, 12]
    },
    {
      name: "Media & Documents",
      rows: objRowsToSheet(
        ["URL", "Kind", "Subtype", "Type", "Family", "Media URL", "Accessible Name", "Link Text", "Issues", "Issue Count", "HTML"],
        ["url", "kind", "subtype", "type_label", "family", "media_url", "accessible_name", "link_text", "issues", "issue_count", "html_snippet"],
        report.mediaRows
      ),
      colWidths: [50, 12, 10, 18, 12, 50, 30, 25, 40, 11, 50]
    },
    {
      name: "Scan Environment",
      rows: objRowsToSheet(
        ["URL", "Title", "Scan Started", "Duration (ms)", "axe Version", "Test Runner", "User Agent", "Window W", "Window H", "Orientation", "Tool Options", "Error"],
        ["url", "page_title", "scan_started_at", "scan_duration_ms", "axe_version", "test_runner", "user_agent", "window_width", "window_height", "orientation_type", "tool_options", "error"],
        report.envRows
      ),
      colWidths: [50, 30, 20, 12, 12, 14, 55, 10, 10, 14, 40, 30],
      opts: { freezeFirstCol: true }
    }
  ];
  // Workflow mode — the session timeline. One row per step: what happened,
  // where, and how many NEW (deduplicated) issues that step surfaced.
  if (report.workflow) {
    sheets.push({
      name: "Workflow",
      rows: buildWorkflowSheet(report.workflow),
      colWidths: [8, 24, 55, 30, 45, 12, 14, 10, 22],
      opts: { freezeFirstCol: true }
    });
    // Raw (undeduped) views — every occurrence from every scan, in the SAME
    // column format as the unique Violations/Incomplete sheets (identical by
    // construction: the rows come from the same buildReport). The unique
    // sheets are the deliverable; these are the operator's ground truth for
    // re-verifying the dedup. Unique + suppressed = raw, checkable per rule.
    if (report.workflowRaw) {
      sheets.push({
        name: "Violations (Raw)",
        rows: objRowsToSheet(
          ["URL", "Page Title", "WCAG", "Level", "SC Name", "IS 17802", "EN 301 549", "Section 508", "ADA", "Rule ID", "Source", "Rule Impact", "Description", "Help", "Tags", "Node Impact", "Target", "XPath", "Ancestry", "HTML", "Failure Summary", "Help URL", "Checks (any/all/none)"],
          ["url", "page_title", "wcag_criterion", "wcag_level", "wcag_name", "is17802_clause", "en301549_clause", "section508_ref", "ada_ref", "rule_id", "rule_source", "rule_impact", "rule_description", "rule_help", "rule_tags", "impact", "selector", "xpath", "ancestry", "html_snippet", "failure_summary", "help_url", "checks_summary"],
          withChecks(report.workflowRaw.issueRows)
        ),
        colWidths: [50, 30, 10, 8, 28, 22, 22, 28, 28, 20, 10, 12, 40, 30, 28, 12, 35, 35, 35, 50, 40, 30, 40],
        opts: { freezeFirstCol: true }
      });
      sheets.push({
        name: "Incomplete (Raw)",
        rows: objRowsToSheet(CATEGORY_HEADERS, CATEGORY_KEYS, withChecks(report.workflowRaw.incompleteRows)),
        colWidths: CATEGORY_WIDTHS,
        opts: { freezeFirstCol: true }
      });
    }
  }
  // Guided CDP tests (Phase C) — the stop-by-stop evidence behind the
  // eu-focus-not-visible / eu-keyboard-trap / eu-reflow-* findings.
  if (report.guidedTests) {
    sheets.push({
      name: "Guided Tests",
      rows: buildGuidedTestsSheet(report.guidedTests),
      colWidths: [6, 16, 12, 55, 22, 80],
      opts: { freezeFirstCol: true }
    });
  }
  // v0.4.4 — internal broken-link findings (present when the crawl ran the
  // link check).
  if (report.brokenLinks) {
    sheets.push({
      name: "Broken Links",
      rows: buildBrokenLinksSheet(report.brokenLinks),
      colWidths: BROKEN_LINKS_WIDTHS,
      opts: { freezeFirstCol: true }
    });
  }
  // v0.4.5 — team manual-test checklist, scoped by media rows (report mode
  // has no full content signals; media data still narrows video/audio/PDF
  // tests to the right pages).
  sheets.push({
    name: "Manual Checklist",
    rows: buildManualChecklistSheet(pagesForManualChecklist(report)),
    colWidths: MANUAL_WIDTHS,
    opts: { freezeFirstCol: true }
  });
  if (report.settings) {
    sheets.push({ name: "Scan Settings", rows: buildScanSettingsSheet(report.settings), colWidths: [30, 80] });
  }
  // Excel sheet names cap at 31 chars.
  sheets.forEach(s => { if (s.name.length > 31) s.name = s.name.slice(0, 31); });

  const sheetXmls = sheets.map(s => buildSheet(s.rows, ss, { colWidths: s.colWidths, ...(s.opts || {}) }));

  // Sheet indices must be read AFTER the conditional pushes above, since
  // Broken Links / Manual Checklist / Scan Settings shift nothing before
  // Violations and Pages but would if the order ever changed.
  const idx1 = name => sheets.findIndex(s => s.name === name) + 1;
  const drawingSpecs = [];
  if (violationsBuild.thumbPositions.length && idx1("Violations") > 0) {
    drawingSpecs.push({ sheetIdx1: idx1("Violations"), positions: violationsBuild.thumbPositions });
  }
  if (reportPagesBuild.thumbPositions.length && idx1("Pages") > 0) {
    drawingSpecs.push({ sheetIdx1: idx1("Pages"), positions: reportPagesBuild.thumbPositions });
  }

  const z = createZip();
  z.addText("[Content_Types].xml", buildContentTypes(sheets.length, {
    drawings: drawingSpecs.length,
    hasPng: drawingSpecs.length > 0
  }));
  z.addText("_rels/.rels", buildRootRels());
  z.addText("xl/workbook.xml", buildWorkbook(sheets.map(s => s.name)));
  z.addText("xl/_rels/workbook.xml.rels", buildWorkbookRels(sheets.length));
  z.addText("xl/styles.xml", buildStyles());
  sheetXmls.forEach((xml, i) => z.addText(`xl/worksheets/sheet${i + 1}.xml`, xml));
  z.addText("xl/sharedStrings.xml", ss.xml());
  if (drawingSpecs.length) emitDrawingParts(z, drawingSpecs, thumbnails);
  return z.finalize("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

export async function buildAuditXlsx(inventory) {
  // Only include pages that have at least one violation.
  const usedNames = new Set();
  usedNames.add("summary");

  const pageEntries = [];
  for (const p of inventory.pages || []) {
    const findings = collectFindingsForPage(p);
    if (!findings.length) continue;
    pageEntries.push({
      url: p.url,
      title: p.title || "",
      sheetName: auditSheetNameFromUrl(p.url, usedNames),
      findings
    });
  }

  // Combined collections per axe category so the workbook carries the FULL
  // axe output — not just violations: Violations, Needs Review (incomplete),
  // Passes, Inapplicable. Each is one combined sheet (URL + the per-node
  // columns). Per-URL sheets stay violations-only (the actionable work-list).
  const combinedFor = (category) => {
    const entries = [];
    for (const p of inventory.pages || []) {
      const f = collectFindingsForPage(p, category);
      if (f.length) entries.push({ url: p.url, findings: f });
    }
    return entries;
  };
  const incompleteEntries   = combinedFor("incomplete");
  const passEntries         = combinedFor("passes");
  const inapplicableEntries = combinedFor("inapplicable");

  // Column widths in Excel character units. Tuned so the cell contents
  // wrap to 2-4 lines rather than overflowing to the right.
  const COMBINED_WIDTHS    = [50, 18, 11, 11, 22, 13, 16, 28, 40, 28, 30, 35, 35, 35, 50, 40, 40];
  const AUDIT_PAGE_WIDTHS  = [18, 11, 11, 22, 13, 16, 28, 40, 28, 30, 35, 35, 35, 50, 40, 40];

  const ss = createSharedStrings();
  const sheets = [
    { name: "Combined Report", rows: buildCombinedReportSheet(pageEntries), colWidths: COMBINED_WIDTHS },
    { name: "Needs Review", rows: buildCombinedReportSheet(incompleteEntries), colWidths: COMBINED_WIDTHS },
    { name: "Passes", rows: buildCombinedReportSheet(passEntries), colWidths: COMBINED_WIDTHS },
    { name: "Inapplicable", rows: buildCombinedReportSheet(inapplicableEntries), colWidths: COMBINED_WIDTHS },
    ...pageEntries.map(e => ({
      name: e.sheetName,
      rows: buildAuditPageSheet(e.findings),
      colWidths: AUDIT_PAGE_WIDTHS
    }))
  ];
  // The four combined sheets always exist (header row at minimum), so the
  // workbook is never zero-sheet even when a category is empty.

  const sheetXmls = sheets.map(s => buildSheet(s.rows, ss, { colWidths: s.colWidths }));

  const z = createZip();
  z.addText("[Content_Types].xml", buildContentTypes(sheets.length));
  z.addText("_rels/.rels", buildRootRels());
  z.addText("xl/workbook.xml", buildWorkbook(sheets.map(s => s.name)));
  z.addText("xl/_rels/workbook.xml.rels", buildWorkbookRels(sheets.length));
  z.addText("xl/styles.xml", buildStyles());
  sheetXmls.forEach((xml, i) => z.addText(`xl/worksheets/sheet${i + 1}.xml`, xml));
  z.addText("xl/sharedStrings.xml", ss.xml());
  return z.finalize("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}

// `thumbnails` is an optional Map<shotId, {bytes: Uint8Array, width: number, height: number}>
// — when supplied and non-empty, the Pages sheet grows a "Preview" column
// at column A and the workbook gets xl/media/imageN.png, xl/drawings/drawing1.xml,
// and the matching rels/content-type entries wired in. Without thumbnails,
// the function behaves identically to its previous single-arg form.
export async function buildInventoryXlsx(inventory, { thumbnails = null } = {}) {
  // Column widths in Excel character units — tuned per sheet so cells fit
  // their expected content without overflowing or leaving huge whitespace.
  // If columns are added/reordered, update these arrays to match.
  // Col 1 does double duty as metadata-label AND URL column in the Top-10
  // Pages section, so keep it wide enough for URLs (~55). Col 2 is the
  // value column for metadata rows and holds the rule Impact in the
  // rules-by-frequency section.
  const OVERVIEW_WIDTHS = [55, 55, 18, 18, 50];
  // With thumbnails the first column becomes Preview (~44 char units ≈ 300px).
  const wantThumbs = thumbnails instanceof Map && thumbnails.size > 0;
  const PREVIEW_WIDTH = 44;
  const PAGES_WIDTHS_BASE = [
    55, 12, 30, 15, 20, 7, 10, 12, 20, 8,   // URL, Outcome … Is SPA
    11, 11, 9, 11, 11,                      // Violations … Screenshot
    10, 14,                                 // html lang, Visible Text Length
    7, 7, 9, 11, 14, 10,                    // Forms … OTP Inputs
    11, 7, 7, 8, 7, 9,                      // Data Tables … Captions
    8, 8, 6,                                // Iframes, Embeds, SVGs
    8, 10, 6, 7, 10, 9, 12, 10,             // Modals … Dropdowns
    6, 14, 11, 12,                          // Navs … Breadcrumbs
    10, 10, 14,                             // PDF Links, Doc Links, External Links
    8, 14, 16, 10,                          // Images, Images w/o alt, Decorative Images, BG Images
    15, 13,                                 // Elements w/ lang, Shadow Roots
    5, 5, 5, 5, 5, 5, 14,                   // H1…H6, Heading Skips
    10, 12                                  // Has Login, Has CAPTCHA
  ];
  const PAGES_WIDTHS = wantThumbs
    ? [PREVIEW_WIDTH, ...PAGES_WIDTHS_BASE]
    : PAGES_WIDTHS_BASE;
  const TEMPLATES_WIDTHS = [
    15, 20, 11, 55, 15, 8, 18,              // Template ID … SPA Markers
    14, 14, 13,                             // Total Violations, Incomplete, Passes
    10, 14, 10, 10, 11, 10, 12, 9,          // Has Forms … Has Tabs
    10, 13, 14, 12, 13, 10, 12, 14,         // Has Menus … Has Shadow DOM
    40                                      // Content Signal Summary
  ];
  const PROPOSED_SAMPLE_WIDTHS = [5, 55, 15, 20, 30, 20];
  const FORM_FIELDS_WIDTHS = [50, 30, 8, 25, 18, 12, 25, 10, 15];
  const COMPONENTS_WIDTHS = [50, 15, 35, 40];
  const VIOLATIONS_WIDTHS_BASE = [50, 18, 11, 13, 16, 30, 40, 28, 28, 35, 35, 35, 40, 50, 40];
  // Same shift as PAGES_WIDTHS: Preview takes column A when thumbnails exist,
  // so every subsequent width has to move with it or the columns are off by one.
  const VIOLATIONS_WIDTHS = wantThumbs
    ? [PREVIEW_WIDTH, ...VIOLATIONS_WIDTHS_BASE]
    : VIOLATIONS_WIDTHS_BASE;
  const ENV_WIDTHS = [50, 30, 20, 12, 12, 10, 14, 55, 13, 13, 14, 20, 40];
  const ISSUE_SHOTS_WIDTHS = [44, 50, 20, 11, 40, 28];
  const TEST_MATRIX_FIRST_COLS = [15, 20, 55];

  const ss = createSharedStrings();

  // Test Matrix width array: first 3 cols specific, then default 20 per test col.
  const testMatrixRows = buildTestMatrixSheet(inventory);
  const testMatrixCols = testMatrixRows[0]?.length || 3;
  const TEST_MATRIX_WIDTHS = [
    ...TEST_MATRIX_FIRST_COLS,
    ...Array.from({ length: Math.max(0, testMatrixCols - 3) }, () => 20)
  ];

  // Build Pages sheet eagerly so we can capture thumbnail row positions for
  // the drawing pipeline below.
  const pagesBuild = buildPagesSheet(inventory, thumbnails);
  const thumbPositions = pagesBuild.thumbPositions || [];
  // Same for Violations — the inline element preview on each finding's own row.
  const violationsBuild = buildViolationsSheet(inventory, thumbnails);
  const violationsThumbPositions = violationsBuild.thumbPositions || [];
  const violationsRowHeights = rowHeightsFor(violationsThumbPositions);
  // v0.4.3 — issue-specific element screenshots get their own sheet + drawing.
  const issueBuild = wantThumbs ? buildIssueScreenshotsSheet(inventory, thumbnails) : { rows: null, thumbPositions: [] };
  const issueThumbPositions = issueBuild.thumbPositions || [];
  const issueRowHeights = rowHeightsFor(issueThumbPositions);
  const pageRowHeights = rowHeightsFor(wantThumbs ? thumbPositions : []);

  // Sheet order reflects reader priority: Overview first (the director's
  // read), then Violations (the auditor's work-list), then the structural
  // data sheets.
  const sheets = [
    {
      name: "Overview", rows: buildOverviewSheet(inventory),
      colWidths: OVERVIEW_WIDTHS,
      opts: { autoFilter: false, freezeFirstCol: false }
    },
    {
      name: "Violations", rows: violationsBuild.rows,
      colWidths: VIOLATIONS_WIDTHS,
      opts: {
        freezeFirstCol: true,
        rowHeights: violationsRowHeights,
        drawingRelId: (wantThumbs && violationsThumbPositions.length > 0) ? "rId1" : null
      }
    },
    {
      name: "Pages", rows: pagesBuild.rows,
      colWidths: PAGES_WIDTHS,
      opts: {
        freezeFirstCol: true,
        rowHeights: pageRowHeights,
        drawingRelId: (wantThumbs && thumbPositions.length > 0) ? "rId1" : null
      }
    },
    {
      name: "Templates", rows: buildTemplatesSheet(inventory),
      colWidths: TEMPLATES_WIDTHS
    },
    {
      name: "Proposed Sample", rows: buildProposedSampleSheet(inventory),
      colWidths: PROPOSED_SAMPLE_WIDTHS
    },
    {
      name: "Form Fields", rows: buildFormFieldsSheet(inventory),
      colWidths: FORM_FIELDS_WIDTHS,
      opts: { freezeFirstCol: true }
    },
    {
      name: "Components", rows: buildComponentsSheet(inventory),
      colWidths: COMPONENTS_WIDTHS,
      opts: { freezeFirstCol: true }
    },
    {
      name: "Test Matrix", rows: testMatrixRows,
      colWidths: TEST_MATRIX_WIDTHS
    },
    {
      name: "Passes", rows: buildResultCategorySheet(inventory, "passes"),
      colWidths: VIOLATIONS_WIDTHS,
      opts: { freezeFirstCol: true }
    },
    {
      name: "Incomplete", rows: buildResultCategorySheet(inventory, "incomplete"),
      colWidths: VIOLATIONS_WIDTHS,
      opts: { freezeFirstCol: true }
    },
    {
      name: "Inapplicable", rows: buildResultCategorySheet(inventory, "inapplicable"),
      colWidths: VIOLATIONS_WIDTHS,
      opts: { freezeFirstCol: true }
    },
    {
      name: "Scan Environment", rows: buildEnvironmentSheet(inventory),
      colWidths: ENV_WIDTHS,
      opts: { freezeFirstCol: true }
    }
  ];
  // v0.4.4 — internal broken-link findings (present when the crawl ran the
  // link check).
  if (inventory.brokenLinks) {
    sheets.push({
      name: "Broken Links",
      rows: buildBrokenLinksSheet(inventory.brokenLinks),
      colWidths: BROKEN_LINKS_WIDTHS,
      opts: { freezeFirstCol: true }
    });
  }
  // v0.4.5 — team manual-test checklist scoped by the per-page content
  // signals (forms, modals, carousels, video, …) the crawler collected.
  sheets.push({
    name: "Manual Checklist",
    rows: buildManualChecklistSheet(inventory.pages || []),
    colWidths: MANUAL_WIDTHS,
    opts: { freezeFirstCol: true }
  });
  if (inventory.settings) {
    sheets.push({ name: "Scan Settings", rows: buildScanSettingsSheet(inventory.settings), colWidths: [30, 80] });
  }
  // Excel sheet names cap at 31 chars — keep safe.
  sheets.forEach(s => { if (s.name.length > 31) s.name = s.name.slice(0, 31); });

  // Pages sheet index (1-based) — the drawing pipeline needs this so it can
  // write xl/worksheets/_rels/sheet{N}.xml.rels pointing at the drawing.
  // Append the Issue Screenshots sheet (only when element shots were captured).
  if (issueThumbPositions.length > 0) {
    sheets.push({
      name: "Issue Screenshots",
      rows: issueBuild.rows,
      colWidths: ISSUE_SHOTS_WIDTHS,
      opts: { rowHeights: issueRowHeights, drawingRelId: "rId1" }
    });
  }

  const pagesSheetIdx1 = sheets.findIndex(s => s.name === "Pages") + 1;

  const sheetXmls = sheets.map(s => buildSheet(s.rows, ss, {
    colWidths: s.colWidths,
    ...(s.opts || {})
  }));

  const issueSheetIdx1 = sheets.findIndex(s => s.name === "Issue Screenshots") + 1;
  const violationsSheetIdx1 = sheets.findIndex(s => s.name === "Violations") + 1;

  // Each spec = a worksheet carrying embedded images. Generalised from the
  // single Pages drawing so the element screenshots get their own drawing too.
  // Media images are numbered sequentially across all drawings; each drawing's
  // rels map its local rIds to the correct global image via an offset.
  //
  // The same shotId can appear in more than one spec — an element preview shows
  // both inline on its Violations row and again on the Issue Screenshots sheet.
  // That is intentional: OOXML requires each drawing to own its image parts, so
  // the bytes are written once per spec rather than shared. Element crops are
  // small (~400x300 PNG) and MAX_ISSUE_SHOTS caps the count, so the duplication
  // costs little next to the readability gain.
  const drawingSpecs = [];
  if (wantThumbs && violationsThumbPositions.length > 0 && violationsSheetIdx1 > 0) {
    drawingSpecs.push({ sheetIdx1: violationsSheetIdx1, positions: violationsThumbPositions });
  }
  if (wantThumbs && thumbPositions.length > 0) {
    drawingSpecs.push({ sheetIdx1: pagesSheetIdx1, positions: thumbPositions });
  }
  if (issueThumbPositions.length > 0 && issueSheetIdx1 > 0) {
    drawingSpecs.push({ sheetIdx1: issueSheetIdx1, positions: issueThumbPositions });
  }

  const z = createZip();
  z.addText("[Content_Types].xml", buildContentTypes(sheets.length, {
    drawings: drawingSpecs.length,
    hasPng: drawingSpecs.length > 0
  }));
  z.addText("_rels/.rels", buildRootRels());
  z.addText("xl/workbook.xml", buildWorkbook(sheets.map(s => s.name)));
  z.addText("xl/_rels/workbook.xml.rels", buildWorkbookRels(sheets.length));
  z.addText("xl/styles.xml", buildStyles());
  sheetXmls.forEach((xml, i) => z.addText(`xl/worksheets/sheet${i + 1}.xml`, xml));
  // sharedStrings MUST be emitted after all sheets reference it (we've built
  // the strings during sheet XML generation above).
  z.addText("xl/sharedStrings.xml", ss.xml());

  emitDrawingParts(z, drawingSpecs, thumbnails);

  return z.finalize("application/vnd.openxmlformats-officedocument.spreadsheetml.sheet");
}
