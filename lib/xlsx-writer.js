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

function esc(s) {
  return String(s ?? "")
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
function buildSheet(rows, ss, { headerBold = true } = {}) {
  // rows: array of arrays. All cell values are strings OR numbers.
  const rowParts = rows.map((row, rIdx) => {
    const rowNum = rIdx + 1;
    const cells = row.map((v, cIdx) => {
      const ref = `${colLetter(cIdx)}${rowNum}`;
      if (v === null || v === undefined || v === "") return `<c r="${ref}"/>`;
      if (typeof v === "number" && !Number.isNaN(v)) {
        return `<c r="${ref}"${rIdx === 0 && headerBold ? ` s="1"` : ""}><v>${v}</v></c>`;
      }
      const sIdx = ss.add(String(v));
      return `<c r="${ref}" t="s"${rIdx === 0 && headerBold ? ` s="1"` : ""}><v>${sIdx}</v></c>`;
    }).join("");
    return `<row r="${rowNum}">${cells}</row>`;
  }).join("");

  const maxCols = rows.reduce((n, r) => Math.max(n, r.length), 1);
  const dim = `A1:${colLetter(maxCols - 1)}${rows.length}`;

  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <dimension ref="${dim}"/>
  <sheetViews><sheetView workbookViewId="0"><pane ySplit="1" topLeftCell="A2" activePane="bottomLeft" state="frozen"/></sheetView></sheetViews>
  <sheetFormatPr defaultRowHeight="15"/>
  <sheetData>${rowParts}</sheetData>
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

function buildContentTypes(sheetCount) {
  const overrides = [];
  for (let i = 1; i <= sheetCount; i++) {
    overrides.push(`<Override PartName="/xl/worksheets/sheet${i}.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>`);
  }
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>
  <Override PartName="/xl/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.styles+xml"/>
  <Override PartName="/xl/sharedStrings.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sharedStrings+xml"/>
  ${overrides.join("")}
</Types>`;
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
  <cellXfs count="2">
    <xf numFmtId="0" fontId="0" fillId="0" borderId="0" xfId="0"/>
    <xf numFmtId="0" fontId="1" fillId="2" borderId="0" xfId="0" applyFont="1" applyFill="1"/>
  </cellXfs>
</styleSheet>`;
}

// ── Inventory → sheet rows ─────────────────────────────────────────────
function buildPagesSheet(inventory) {
  const rows = [[
    "URL", "Title", "Template ID", "URL Cluster", "Depth", "Source",
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
  ]];
  for (const p of inventory.pages) {
    if (p.error) {
      rows.push([
        p.url, "(error)", p.template_id || "", p.url_cluster || "",
        p.depth ?? "", p.source || "", "", "", "", "", "", "", "", "No",
        ...Array.from({ length: 47 }, () => "")
      ]);
      continue;
    }
    const c = p.counts || {};
    const f = p.flags || {};
    const a = p.audit || {};
    rows.push([
      p.url, p.title || "", p.template_id || "", p.url_cluster || "",
      p.depth ?? "", p.source || "",
      p.pageType || "unknown", (p.spaMarkers || []).join(", "), f.isSPA ? "Yes" : "No",
      (a.violations || []).length, (a.incomplete || []).length,
      (a.passes || []).length, (a.inapplicable || []).length,
      p.screenshot?.dataUrl ? "Yes" : "No",
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
    ]);
  }
  return rows;
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
// this granular; it's the actual work-list.
function buildViolationsSheet(inventory) {
  const rows = [[
    "URL", "Rule ID", "Impact", "Description", "Help", "Help URL",
    "WCAG Tags", "Target Selector", "Failure Summary", "HTML"
  ]];
  for (const p of inventory.pages) {
    if (p.error) continue;
    for (const v of (p.audit?.violations || [])) {
      const wcagTags = (v.tags || []).filter(t => /^wcag\d+/i.test(t)).join(", ");
      const nodes = v.nodes || [];
      if (!nodes.length) {
        rows.push([
          p.url, v.id || "", v.impact || "", v.description || "", v.help || "",
          v.helpUrl || "", wcagTags, "", "", ""
        ]);
        continue;
      }
      for (const n of nodes) {
        rows.push([
          p.url, v.id || "", v.impact || "", v.description || "", v.help || "",
          v.helpUrl || "", wcagTags,
          (n.target || []).join(" "),
          n.failureSummary || "",
          (n.html || "").slice(0, 500)
        ]);
      }
    }
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

export async function buildInventoryXlsx(inventory) {
  const ss = createSharedStrings();
  const sheets = [
    { name: "Pages", rows: buildPagesSheet(inventory) },
    { name: "Templates", rows: buildTemplatesSheet(inventory) },
    { name: "Proposed Sample", rows: buildProposedSampleSheet(inventory) },
    { name: "Form Fields", rows: buildFormFieldsSheet(inventory) },
    { name: "Components", rows: buildComponentsSheet(inventory) },
    { name: "Violations", rows: buildViolationsSheet(inventory) },
    { name: "Test Matrix", rows: buildTestMatrixSheet(inventory) }
  ];
  // Excel sheet names cap at 31 chars — keep safe.
  sheets.forEach(s => { if (s.name.length > 31) s.name = s.name.slice(0, 31); });

  const sheetXmls = sheets.map(s => buildSheet(s.rows, ss));

  const z = createZip();
  z.addText("[Content_Types].xml", buildContentTypes(sheets.length));
  z.addText("_rels/.rels", buildRootRels());
  z.addText("xl/workbook.xml", buildWorkbook(sheets.map(s => s.name)));
  z.addText("xl/_rels/workbook.xml.rels", buildWorkbookRels(sheets.length));
  z.addText("xl/styles.xml", buildStyles());
  sheetXmls.forEach((xml, i) => z.addText(`xl/worksheets/sheet${i + 1}.xml`, xml));
  // sharedStrings MUST be emitted after all sheets reference it (we've built
  // the strings during sheet XML generation above).
  z.addText("xl/sharedStrings.xml", ss.xml());
  return z.finalize();
}
