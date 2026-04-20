// Minimal OOXML .docx generator — produces a valid Word document from an
// inventory object. Uses zip-writer for the zip shell; emits the required
// OOXML parts (_rels, Content_Types, word/document.xml, word/styles.xml).
//
// Scope of generated document:
//   1. Cover page: title, site, date, counts (pages / templates / content
//      types detected).
//   2. Executive summary — one paragraph written from the crawl numbers.
//   3. Methodology — describes how pages were discovered and clustered.
//   4. Template breakdown table — one row per template, with sample URL
//      and recommended manual tests derived from content-signals.
//   5. Proposed sample — the URLs we recommend the auditor tests.
//   6. Assumptions and exclusions.
//   7. Acceptance criteria.
//
// Only writes text + tables + headings. No images, no embedded fonts, no
// headers/footers. That's plenty for a scope document.

import { createZip } from "./zip-writer.js";

function esc(s) {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

// ── OOXML helpers ──────────────────────────────────────────────────────
function paragraph(text, { style, bold = false, size = 22, align } = {}) {
  const pPr = [
    style ? `<w:pStyle w:val="${esc(style)}"/>` : "",
    align ? `<w:jc w:val="${esc(align)}"/>` : ""
  ].filter(Boolean).join("");
  const rPr = [
    bold ? `<w:b/>` : "",
    `<w:sz w:val="${size}"/>`
  ].filter(Boolean).join("");
  return `<w:p>${pPr ? `<w:pPr>${pPr}</w:pPr>` : ""}<w:r>${rPr ? `<w:rPr>${rPr}</w:rPr>` : ""}<w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function heading(text, level = 1) {
  const styleName = level === 1 ? "Heading1" : level === 2 ? "Heading2" : "Heading3";
  const size = level === 1 ? 36 : level === 2 ? 28 : 24;
  return `<w:p><w:pPr><w:pStyle w:val="${styleName}"/></w:pPr><w:r><w:rPr><w:b/><w:sz w:val="${size}"/><w:color w:val="1E40AF"/></w:rPr><w:t xml:space="preserve">${esc(text)}</w:t></w:r></w:p>`;
}

function emptyParagraph() {
  return `<w:p/>`;
}

function tableRow(cells, { header = false, widths } = {}) {
  const tcs = cells.map((text, i) => {
    const w = widths?.[i];
    const tcPr = w ? `<w:tcPr><w:tcW w:w="${w}" w:type="dxa"/></w:tcPr>` : "";
    const shd = header ? `<w:shd w:val="clear" w:color="auto" w:fill="F1F5F9"/>` : "";
    const tcPrFull = shd ? (tcPr ? tcPr.replace("</w:tcPr>", `${shd}</w:tcPr>`) : `<w:tcPr>${shd}</w:tcPr>`) : tcPr;
    return `<w:tc>${tcPrFull}${paragraph(text, { bold: header, size: header ? 20 : 20 })}</w:tc>`;
  }).join("");
  return `<w:tr>${tcs}</w:tr>`;
}

function table(rows, { widths } = {}) {
  const rowsXml = rows.map((r, idx) => tableRow(r, { header: idx === 0, widths })).join("");
  const gridCols = widths ? widths.map(w => `<w:gridCol w:w="${w}"/>`).join("") : "";
  return `<w:tbl>
    <w:tblPr>
      <w:tblStyle w:val="TableGrid"/>
      <w:tblW w:w="5000" w:type="pct"/>
      <w:tblBorders>
        <w:top w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/>
        <w:left w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/>
        <w:bottom w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/>
        <w:right w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/>
        <w:insideH w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/>
        <w:insideV w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/>
      </w:tblBorders>
    </w:tblPr>
    ${gridCols ? `<w:tblGrid>${gridCols}</w:tblGrid>` : ""}
    ${rowsXml}
  </w:tbl>`;
}

// ── Document assembly ──────────────────────────────────────────────────
function buildDocumentXml(inventory) {
  const { meta, templates, pages, contentTypeSummary, proposedSample, recommendedTestsUnion } = inventory;
  const generatedOn = new Date(meta.generatedAt).toLocaleString();
  const parts = [];

  // Cover
  parts.push(heading("Accessibility Audit — Scope Document", 1));
  parts.push(paragraph(`Prepared by: EnableUser Accessibility Widget`, { size: 22 }));
  parts.push(paragraph(`Target: ${meta.seedUrl}`, { size: 22 }));
  parts.push(paragraph(`Date: ${generatedOn}`, { size: 22 }));
  parts.push(paragraph(`Discovery crawl depth: ${meta.crawlDepth ?? 1}, URL cap: ${meta.maxUrls ?? pages.length}`, { size: 20 }));
  parts.push(emptyParagraph());

  // Exec summary stats
  parts.push(heading("1. Executive Summary", 2));
  parts.push(paragraph(
    `The discovery crawl reached ${pages.length} unique URL${pages.length === 1 ? "" : "s"} ` +
    `on ${meta.seedHost}. Pages cluster into ${templates.length} template${templates.length === 1 ? "" : "s"} ` +
    `based on DOM fingerprint and URL shape. This scope document proposes a ` +
    `${proposedSample.length}-URL audit sample — one representative URL per template, plus critical-path pages (home, login, contact, search, forms). ` +
    `A total manual-test surface of ${recommendedTestsUnion.length} distinct manual checks was derived from the content-type detection.`,
    { size: 22 }
  ));
  parts.push(emptyParagraph());

  // Methodology
  parts.push(heading("2. Methodology", 2));
  parts.push(paragraph("The EnableUser extension runs inside a real logged-in Chrome browser (same session, same cookies, same geography as the user). Discovery covers:", { size: 22 }));
  parts.push(paragraph("• Seed page and same-hostname body/nav links crawled to the configured depth.", { size: 22 }));
  parts.push(paragraph("• sitemap.xml + sitemap index expansion via robots.txt.", { size: 22 }));
  parts.push(paragraph("• hreflang alternate URLs from <link rel=\"alternate\"> tags.", { size: 22 }));
  parts.push(paragraph("• Common governance paths probed: /accessibility, /terms, /privacy, /contact, /sitemap.", { size: 22 }));
  parts.push(paragraph("• DOM-shape fingerprint (landmarks + roles + heading tree + layout class patterns) + URL-shape cluster. Pages with matching fingerprints are grouped as the same template.", { size: 22 }));
  parts.push(paragraph("• Per-page content-type detection: forms, video/audio, data tables, iframes, modals, carousels, tabs, menus, accordions, datepickers, dropdowns, PDF links, login surfaces, CAPTCHA. This detection drives the per-template manual-test checklist.", { size: 22 }));
  parts.push(emptyParagraph());

  // Template breakdown
  parts.push(heading("3. Template Breakdown", 2));
  parts.push(paragraph(`${templates.length} template${templates.length === 1 ? "" : "s"} detected across the crawl.`, { size: 22 }));
  parts.push(emptyParagraph());
  {
    const rows = [
      ["Template ID", "URL Cluster", "Pages", "Sample URL", "Content Signals"]
    ];
    for (const t of templates) {
      rows.push([
        t.template_id,
        t.url_cluster,
        String(t.page_count),
        t.sample_url,
        t.contentSignalSummary || "—"
      ]);
    }
    parts.push(table(rows, { widths: [1600, 1800, 800, 4000, 3500] }));
  }
  parts.push(emptyParagraph());

  // Content-type detection summary
  parts.push(heading("4. Content-Type Detection Summary", 2));
  parts.push(paragraph("Presence of each content type across the crawled corpus:", { size: 22 }));
  parts.push(emptyParagraph());
  {
    const rows = [["Content Type", "Pages"]];
    for (const [k, v] of Object.entries(contentTypeSummary)) {
      rows.push([k, String(v)]);
    }
    parts.push(table(rows, { widths: [4000, 2000] }));
  }
  parts.push(emptyParagraph());

  // Proposed sample
  parts.push(heading("5. Proposed Audit Sample", 2));
  parts.push(paragraph(`${proposedSample.length} URL${proposedSample.length === 1 ? "" : "s"} recommended for the full audit pass. One representative per template + critical-path pages.`, { size: 22 }));
  parts.push(emptyParagraph());
  {
    const rows = [["#", "URL", "Template", "Reason"]];
    proposedSample.forEach((s, i) => {
      rows.push([String(i + 1), s.url, s.template_id, s.reason || "Template representative"]);
    });
    parts.push(table(rows, { widths: [500, 4500, 1500, 3500] }));
  }
  parts.push(emptyParagraph());

  // Manual-test union
  parts.push(heading("6. Manual Test Matrix", 2));
  parts.push(paragraph("Manual-only checks derived from the content-type detection. Each check is required for one or more templates in the proposed sample. A full audit report will document pass/fail per test per URL.", { size: 22 }));
  parts.push(emptyParagraph());
  {
    const rows = [["#", "Manual Check", "WCAG / Reason"]];
    recommendedTestsUnion.forEach((t, i) => {
      rows.push([String(i + 1), t.test, t.why]);
    });
    parts.push(table(rows, { widths: [500, 4500, 5000] }));
  }
  parts.push(emptyParagraph());

  // Assumptions & exclusions
  parts.push(heading("7. Assumptions and Exclusions", 2));
  parts.push(paragraph("Assumptions:", { bold: true, size: 22 }));
  parts.push(paragraph("• Scope is limited to public-web pages reachable from the seed URL on the same hostname.", { size: 22 }));
  parts.push(paragraph("• Client provides credentials for any authenticated areas in scope.", { size: 22 }));
  parts.push(paragraph("• axe-core 4.11.3 is used for automated rule coverage (WCAG 2.1 A + AA tags).", { size: 22 }));
  parts.push(paragraph("• Manual testing covers keyboard, focus management, screen-reader semantic output, zoom/reflow, reduced-motion respect, and content-type-specific checks per template.", { size: 22 }));
  parts.push(emptyParagraph());
  parts.push(paragraph("Exclusions (unless explicitly added to scope in writing):", { bold: true, size: 22 }));
  parts.push(paragraph("• Third-party widgets whose source the client does not control (chat, analytics, ads).", { size: 22 }));
  parts.push(paragraph("• Native iOS / Android app accessibility.", { size: 22 }));
  parts.push(paragraph("• PDF / DOCX / PPTX accessibility (tagged-PDF review available as a separate deliverable).", { size: 22 }));
  parts.push(paragraph("• Pre-hydration HTML (we scan post-hydration live DOM — a separate SSR/SEO check would be needed).", { size: 22 }));
  parts.push(emptyParagraph());

  // Acceptance criteria
  parts.push(heading("8. Acceptance Criteria", 2));
  parts.push(paragraph("The audit is considered complete when:", { size: 22 }));
  parts.push(paragraph("• Each template representative URL has a recorded automated (axe) scan + manual test pass.", { size: 22 }));
  parts.push(paragraph("• All critical / serious issues have a reproduction selector, WCAG reference, and proposed remediation.", { size: 22 }));
  parts.push(paragraph("• A VPAT / ACR is produced mapping findings to the requested compliance profile (WCAG 2.1 AA, IS 17802, GIGW 3.0, EN 301 549, Section 508, or ADA Title III).", { size: 22 }));
  parts.push(paragraph("• A regression baseline is locked so a future re-audit produces a pass/fail/new/regressed diff.", { size: 22 }));

  // Assemble
  const body = parts.join("\n");
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"
            xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">
  <w:body>
    ${body}
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440" w:header="720" w:footer="720" w:gutter="0"/></w:sectPr>
  </w:body>
</w:document>`;
}

function buildStylesXml() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
  <w:docDefaults>
    <w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:cs="Calibri"/><w:sz w:val="22"/></w:rPr></w:rPrDefault>
    <w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="276" w:lineRule="auto"/></w:pPr></w:pPrDefault>
  </w:docDefaults>
  <w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:pPr><w:spacing w:before="240" w:after="120"/></w:pPr><w:rPr><w:b/><w:sz w:val="36"/><w:color w:val="1E40AF"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:pPr><w:spacing w:before="200" w:after="100"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/><w:color w:val="1E40AF"/></w:rPr></w:style>
  <w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:pPr><w:spacing w:before="160" w:after="80"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/><w:color w:val="1E3A8A"/></w:rPr></w:style>
  <w:style w:type="table" w:styleId="TableGrid"><w:name w:val="Table Grid"/><w:tblPr><w:tblBorders><w:top w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/><w:left w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/><w:bottom w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/><w:right w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/><w:insideH w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/><w:insideV w:val="single" w:sz="4" w:space="0" w:color="E5E7EB"/></w:tblBorders></w:tblPr></w:style>
</w:styles>`;
}

function buildContentTypes() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">
  <Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/>
  <Default Extension="xml" ContentType="application/xml"/>
  <Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>
  <Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/>
</Types>`;
}

function buildRootRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/>
</Relationships>`;
}

function buildDocumentRels() {
  return `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">
  <Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>
</Relationships>`;
}

export async function buildScopeDocx(inventory) {
  const z = createZip();
  z.addText("[Content_Types].xml", buildContentTypes());
  z.addText("_rels/.rels", buildRootRels());
  z.addText("word/_rels/document.xml.rels", buildDocumentRels());
  z.addText("word/document.xml", buildDocumentXml(inventory));
  z.addText("word/styles.xml", buildStylesXml());
  return z.finalize();
}
