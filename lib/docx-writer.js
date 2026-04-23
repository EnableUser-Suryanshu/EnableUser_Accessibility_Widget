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
  const { meta, templates, pages, contentTypeSummary, proposedSample, recommendedTestsUnion, corpusAudit } = inventory;
  const generatedOn = new Date(meta.generatedAt).toLocaleString();
  const depthLabel = meta.crawlDepthLabel || (Number.isFinite(meta.crawlDepth) ? String(meta.crawlDepth) : "unbounded");
  const parts = [];

  // Audit totals roll-up for the exec summary.
  const a = corpusAudit || { violations: 0, incomplete: 0, passes: 0, inapplicable: 0, pagesAudited: 0, pagesScreenshotted: 0 };
  const dynamicPages = pages.filter(p => !p.error && p.pageType === "dynamic").length;
  const staticPages = pages.filter(p => !p.error && p.pageType === "static").length;

  // Cover
  parts.push(heading("Accessibility Audit — Scope Document", 1));
  parts.push(paragraph(`Prepared by: EnableUser Accessibility Widget`, { size: 22 }));
  parts.push(paragraph(`Target: ${meta.seedUrl}`, { size: 22 }));
  parts.push(paragraph(`Date: ${generatedOn}`, { size: 22 }));
  parts.push(paragraph(`Discovery crawl depth: ${depthLabel}, URL cap: ${meta.maxUrls ?? pages.length}`, { size: 20 }));
  parts.push(emptyParagraph());

  // Exec summary stats
  parts.push(heading("1. Executive Summary", 2));
  parts.push(paragraph(
    `The discovery crawl reached ${pages.length} unique URL${pages.length === 1 ? "" : "s"} ` +
    `on ${meta.seedHost}. Pages cluster into ${templates.length} template${templates.length === 1 ? "" : "s"} ` +
    `based on DOM fingerprint and URL shape. Of the reachable pages, ${staticPages} classify as static and ${dynamicPages} as dynamic (SPA / client-rendered). ` +
    `This scope document proposes a ` +
    `${proposedSample.length}-URL audit sample — one representative URL per template, plus critical-path pages (home, login, contact, search, forms). ` +
    `A total manual-test surface of ${recommendedTestsUnion.length} distinct manual checks was derived from the content-type detection.`,
    { size: 22 }
  ));
  parts.push(paragraph(
    `Automated audit roll-up (axe-core 4.11.3 + IS 17802 + GIGW 3.0 custom checks, executed live against every crawled page): ` +
    `${a.violations} violation instance${a.violations === 1 ? "" : "s"}, ` +
    `${a.incomplete} needs-review, ` +
    `${a.passes} pass${a.passes === 1 ? "" : "es"}, ` +
    `${a.inapplicable} inapplicable. ` +
    `${a.pagesAudited} page${a.pagesAudited === 1 ? "" : "s"} audited; ${a.pagesScreenshotted} full-page screenshot${a.pagesScreenshotted === 1 ? "" : "s"} captured.`,
    { size: 22 }
  ));
  parts.push(emptyParagraph());

  // Methodology
  parts.push(heading("2. Methodology", 2));
  parts.push(paragraph("The EnableUser extension runs inside a real logged-in Chrome browser (same session, same cookies, same geography as the user). Every crawled URL is opened in a real tab, rendered to post-hydration state, scrolled to exhaust lazy-loaded content, and audited live. Discovery is evidence-based — we do not probe speculative or guessed URLs. Sources:", { size: 22 }));
  parts.push(paragraph("• sitemap.xml + sitemap-index walk (unbounded depth), augmented by Sitemap: directives in robots.txt.", { size: 22 }));
  parts.push(paragraph("• hreflang alternate URLs from <link rel=\"alternate\"> tags on the seed page.", { size: 22 }));
  parts.push(paragraph("• In-browser link discovery from every rendered page: nav/header/footer links, body links, shadow-DOM traversal, mega-menu expansion (click + hover triggers), infinite-scroll exhaustion, and route paths harvested from Next.js / Nuxt / Apollo / Redux JSON hydration dumps.", { size: 22 }));
  parts.push(paragraph("• DOM-shape fingerprint (landmarks + roles + heading tree + layout class patterns) — pages with matching fingerprints are grouped as the same template.", { size: 22 }));
  parts.push(paragraph("• Per-page content-type detection: forms, video/audio, data tables, iframes, modals, carousels, tabs, menus, accordions, datepickers, dropdowns, PDF links, login surfaces, CAPTCHA. This detection drives the per-template manual-test checklist in the component inventory.", { size: 22 }));
  parts.push(paragraph("• Post-crawl shell / soft-404 detection: any URL whose DOM fingerprint and visible text both match the seed page's is classified as a shell page and excluded from the pages and templates tables (surfaced separately as \"Shell / Soft-404 Pages\"). This prevents SPA route fallbacks from inflating inventory counts.", { size: 22 }));
  parts.push(emptyParagraph());

  // Conformance Scope & Limitations — the honest scope-boundary section.
  // This is the defensible-vs-marketing framing: what the tool catches
  // automatically, what it can't catch, and exactly how the manual audit
  // on top of this inventory closes the gap.
  const selectedProfile = meta.profile || "wcag21aa";
  const profileLabels = {
    wcag21aa:    "WCAG 2.1 AA",
    is17802:     "IS 17802 (India)",
    gigw3:       "GIGW 3.0 (NIC)",
    combined_in: "WCAG 2.1 AA + IS 17802 + GIGW 3.0 (Combined India)",
    en301549:    "EN 301 549 v3.2.1 (EU)",
    section508:  "Section 508 (US)",
    ada:         "ADA Title III (US)"
  };
  const profileLabel = profileLabels[selectedProfile] || "WCAG 2.1 AA";
  parts.push(heading("3. Conformance Scope & Limitations", 2));
  parts.push(paragraph(`Selected compliance profile for this engagement: ${profileLabel}.`, { bold: true, size: 22 }));
  parts.push(emptyParagraph());

  parts.push(paragraph("What the automated pass covers:", { bold: true, size: 22 }));
  parts.push(paragraph("• axe-core 4.11.3 rules mapped to WCAG 2.1 Level A and AA success criteria, executed against the post-hydration DOM of every crawled page (seed + sitemap + hreflang + in-browser-discovered links).", { size: 22 }));
  parts.push(paragraph("• Four India-specific custom rules (Devanagari / Bengali / Tamil / etc. script-to-lang mismatch on WCAG 3.1.1; passage-level lang switch detection on 3.1.2; RTL direction for Arabic/Urdu content on 1.3.4; font script-coverage for regional fonts on 1.4.1).", { size: 22 }));
  parts.push(paragraph("• GIGW 3.0 governance clauses via the shared CRITERION_MAP — every WCAG finding carries its GIGW clause, IS 17802 clause, EN 301 549 section, and Section 508 reference.", { size: 22 }));
  parts.push(paragraph("• Content-type detection per page — forms, video/audio, tables, modals, carousels, tabs, menus, accordions, datepickers, dropdowns, PDF links, login surfaces, CAPTCHA, shadow DOM — with the actual component values (field labels, input types, modal titles, tab labels, menu items, table captions, carousel slide counts) recorded as evidence for manual test case drafting.", { size: 22 }));
  parts.push(emptyParagraph());

  if (selectedProfile === "is17802") {
    parts.push(paragraph("IS 17802 Part 1 chapter coverage (India):", { bold: true, size: 22 }));
    parts.push(paragraph("• Chapter 9 (Web content): covered by the automated pass above, which mirrors EN 301 549 v3.2.1 / WCAG 2.1 A+AA.", { size: 22 }));
    parts.push(paragraph("• Chapters 5 (closed-functionality / biometrics / two-way voice), 6 (two-way voice communication), 7 (video caption accuracy — we detect <track> presence, not content accuracy), 8 (hardware), 10 (non-web documents — PDF links counted but PDFs are not audited by this pass), 11 (non-web software), 12 (documentation / support), 13 (relay / emergency services) are NOT auditable by any web crawler. If in scope they must be assessed through manual hardware / document / process review.", { size: 22 }));
    parts.push(emptyParagraph());
  } else if (selectedProfile === "en301549") {
    parts.push(paragraph("EN 301 549 v3.2.1 (EU) chapter coverage:", { bold: true, size: 22 }));
    parts.push(paragraph("• Chapter 9 / 10 (Web content + non-web documents): Chapter 9 covered automatically; non-web documents (PDFs, downloadable DOCX / XLSX) require separate tagged-document review and are out of scope for this pass unless explicitly added.", { size: 22 }));
    parts.push(paragraph("• Chapters 5–8, 11–13 (hardware, two-way voice, non-web software, documentation, relay services) are out of scope for automated web testing.", { size: 22 }));
    parts.push(emptyParagraph());
  } else if (selectedProfile === "gigw3") {
    parts.push(paragraph("GIGW 3.0 scope note:", { bold: true, size: 22 }));
    parts.push(paragraph("GIGW 3.0 inherits WCAG 2.1 A+AA as its accessibility baseline (covered automatically) plus governance clauses around multilingual content, citizen services, and grievance redressal. Governance clauses that depend on process / policy evidence (grievance redressal SLAs, privacy policy content, cyber-security certifications) are surfaced where content-detectable but ultimately require client-supplied evidence.", { size: 22 }));
    parts.push(emptyParagraph());
  } else if (selectedProfile === "combined_in") {
    parts.push(paragraph("Combined India profile (WCAG 2.1 AA + IS 17802 + GIGW 3.0):", { bold: true, size: 22 }));
    parts.push(paragraph("Unions the three India-relevant standards. The three share the same WCAG 2.1 A+AA success-criterion set (50 SCs); the combined view additionally emits each finding's clause citation under all three numbering schemes (WCAG x.y.z / IS 17802 Part 1, 9.x.y.z / GIGW 5.2.n). Use this profile for Indian government or public-sector engagements that must demonstrate conformance to IS 17802 and GIGW 3.0 simultaneously while keeping the WCAG mapping visible.", { size: 22 }));
    parts.push(paragraph("Non-web chapters of IS 17802 (hardware, two-way voice, documentation) and governance clauses of GIGW that depend on process / policy evidence (grievance redressal SLAs, privacy policy content) remain out of scope for automated web testing — see the IS 17802 and GIGW 3.0 notes above for details.", { size: 22 }));
    parts.push(emptyParagraph());
  } else if (selectedProfile === "section508") {
    parts.push(paragraph("Section 508 (US) scope note:", { bold: true, size: 22 }));
    parts.push(paragraph("Section 508 adopts WCAG 2.0 A+AA as its baseline (the 2018 Refresh). The automated pass covers the WCAG 2.0 rule-set mapped through axe-core; WCAG 2.1-only criteria (orientation, reflow, content on hover/focus, etc.) are not in the Section 508 profile and are excluded from conformance scoring.", { size: 22 }));
    parts.push(emptyParagraph());
  } else if (selectedProfile === "ada") {
    parts.push(paragraph("ADA Title III (US) scope note:", { bold: true, size: 22 }));
    parts.push(paragraph("The ADA does not name a technical standard. WCAG 2.1 AA is the de-facto bar applied in DoJ settlements and consent decrees and is what the automated pass covers. Legal defensibility also requires a documented remediation process and accessibility statement — out of the tool's scope, client-supplied.", { size: 22 }));
    parts.push(emptyParagraph());
  }

  parts.push(paragraph("What the automated pass does NOT catch:", { bold: true, size: 22 }));
  parts.push(paragraph("Automated rule-based tools — regardless of vendor — catch approximately 30–40% of WCAG / Chapter 9 issues on the pages they reach. The remaining 60–70% require human judgment: cognitive load, reading order for screen readers, meaningful sequence when visual order ≠ DOM order, sufficient contrast where automated detection fails (e.g. text on gradients / images), caption / transcript accuracy, error-recovery flow in forms, focus management across route transitions, and any criterion that depends on operator intent (labels in name, on-focus change, on-input change).", { size: 22 }));
  parts.push(emptyParagraph());

  parts.push(paragraph("Two classes of pages automated crawling cannot reach:", { bold: true, size: 22 }));
  parts.push(paragraph("1) Authenticated pages. Addressed by running the crawl inside the user's real Chrome session after manual login — session cookies carry forward automatically, and depth-bounded link discovery from the authenticated seed reaches dashboards, account settings, and in-product surfaces. Pages requiring multi-step workflows post-login (e.g. dashboards rendered only after a specific action) are added as explicit manual walkthroughs.", { size: 22 }));
  parts.push(paragraph("2) Dynamic pages reachable only via search, filter, or form submission. No crawler can auto-generate the queries, filter combinations, or form POSTs that materialise these views. Addressed by curating a representative set of queries / filter combinations / form submissions per affected template (drawn from the component inventory in Section 4a) and auditing each via the \"scan current tab\" mode after the operator navigates to the materialised state.", { size: 22 }));
  parts.push(emptyParagraph());

  parts.push(paragraph("How the component inventory bounds the manual audit:", { bold: true, size: 22 }));
  parts.push(paragraph("Section 4a (Component Inventory) enumerates every form, modal, data table, tab set, carousel, and menu on the representative page of each template — including actual field names, input types, dialog titles, table captions, and menu labels. This converts the manual audit from an open-ended \"test the site\" into a bounded \"test these specific components at these specific URLs,\" which is what makes the audit both estimable (N test cases × M URLs) and defensible (evidence that every interactive component in scope was exercised).", { size: 22 }));
  parts.push(emptyParagraph());

  // Template breakdown
  parts.push(heading("4. Template Breakdown", 2));
  parts.push(paragraph(`${templates.length} template${templates.length === 1 ? "" : "s"} detected across the crawl. "Type" is static vs dynamic based on framework markers (React, Nuxt, Angular, Vue, Next.js, Turbo, Svelte/Qwik) plus a low-text / high-script heuristic for unlabelled client-rendered shells.`, { size: 22 }));
  parts.push(emptyParagraph());
  {
    const rows = [
      ["Template ID", "URL Cluster", "Pages", "Type", "Viols.", "Sample URL", "Content Signals"]
    ];
    for (const t of templates) {
      rows.push([
        t.template_id,
        t.url_cluster,
        String(t.page_count),
        t.isSPA ? "dynamic" : (t.sample_pageType || "static"),
        String(t.totalViolations ?? 0),
        t.sample_url,
        t.contentSignalSummary || "—"
      ]);
    }
    parts.push(table(rows, { widths: [1200, 1400, 600, 900, 700, 3200, 2700] }));
  }
  parts.push(emptyParagraph());

  // Component inventory — actual values, per template sample.
  parts.push(heading("4a. Component Inventory (Per Template Sample)", 3));
  parts.push(paragraph("Actual component values captured from each template's representative page. Auditors use this to write per-component test scripts.", { size: 22 }));
  parts.push(emptyParagraph());
  for (const t of templates) {
    const co = t.sample_components;
    if (!co) continue;
    const forms = co.forms || [];
    const modals = co.modals || [];
    const tabs = co.tabs || [];
    const menuItems = co.menuItems || [];
    const carousels = co.carousels || [];
    const tables = co.tables || [];
    const buttons = co.buttons || [];
    const anyComponents = forms.length || modals.length || tabs.length || menuItems.length || carousels.length || tables.length || buttons.length;
    if (!anyComponents) continue;

    parts.push(paragraph(`Template ${t.template_id} (${t.url_cluster}) — sample: ${t.sample_url}`, { bold: true, size: 22 }));

    if (forms.length) {
      parts.push(paragraph(`Forms (${forms.length}):`, { bold: true, size: 20 }));
      forms.slice(0, 10).forEach((f, i) => {
        const meta = [f.name, f.action ? `action=${f.action}` : "", f.method ? `method=${f.method}` : ""].filter(Boolean).join(" · ");
        parts.push(paragraph(`Form #${i + 1}${meta ? ` — ${meta}` : ""}`, { size: 20 }));
        if ((f.fields || []).length) {
          const frows = [["Field", "Type", "Label", "Required", "Autocomplete"]];
          for (const fld of f.fields) {
            frows.push([fld.name || "", fld.type || "", fld.label || "", fld.required ? "Yes" : "", fld.autocomplete || ""]);
          }
          parts.push(table(frows, { widths: [1800, 1200, 3200, 1000, 1800] }));
        }
      });
    }
    if (modals.length) {
      parts.push(paragraph(`Modals / dialogs (${modals.length}):`, { bold: true, size: 20 }));
      for (const m of modals.slice(0, 20)) {
        parts.push(paragraph(`• ${m.role ? `[${m.role}] ` : ""}${m.label || "(no accessible name)"}`, { size: 20 }));
      }
    }
    if (tabs.length) {
      parts.push(paragraph(`Tab labels (${tabs.length}): ${tabs.slice(0, 30).map(t => t.label || "(unlabelled)").join(" · ")}`, { size: 20 }));
    }
    if (menuItems.length) {
      parts.push(paragraph(`Menu / nav items (${menuItems.length}): ${menuItems.slice(0, 40).map(m => m.label || "(no text)").join(" · ")}`, { size: 20 }));
    }
    if (carousels.length) {
      parts.push(paragraph(`Carousels: ${carousels.map((c, i) => `#${i + 1} (${c.slideCount ?? 0} slide(s))`).join(" · ")}`, { size: 20 }));
    }
    if (tables.length) {
      parts.push(paragraph(`Data tables (${tables.length}):`, { bold: true, size: 20 }));
      for (const tbl of tables.slice(0, 15)) {
        const bits = [];
        if (tbl.caption) bits.push(`caption: "${tbl.caption}"`);
        if ((tbl.columnHeaders || []).length) bits.push(`cols: ${tbl.columnHeaders.join(", ")}`);
        if (tbl.rowCount) bits.push(`${tbl.rowCount} row(s)`);
        parts.push(paragraph(`• ${bits.join(" · ") || "(no metadata)"}`, { size: 20 }));
      }
    }
    if (buttons.length) {
      parts.push(paragraph(`Buttons (${buttons.length} first): ${buttons.slice(0, 30).map(b => b.label).filter(Boolean).join(" · ")}`, { size: 20 }));
    }
    parts.push(emptyParagraph());
  }

  // Content-type detection summary
  parts.push(heading("5. Content-Type Detection Summary", 2));
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
  parts.push(heading("6. Proposed Audit Sample", 2));
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

  // Automated audit findings — top rules by violation count across the corpus.
  parts.push(heading("7. Automated Audit Findings", 2));
  {
    const ruleAgg = new Map();
    for (const p of pages) {
      if (p.error) continue;
      for (const v of (p.audit?.violations || [])) {
        if (!ruleAgg.has(v.id)) {
          ruleAgg.set(v.id, {
            id: v.id, impact: v.impact || "", help: v.help || v.description || "",
            helpUrl: v.helpUrl || "", instances: 0, pages: new Set()
          });
        }
        const agg = ruleAgg.get(v.id);
        agg.instances += (v.nodes || []).length || 1;
        agg.pages.add(p.url);
      }
    }
    if (ruleAgg.size === 0) {
      parts.push(paragraph("No automated violations detected across the crawled corpus.", { size: 22 }));
    } else {
      parts.push(paragraph(`${ruleAgg.size} distinct rule${ruleAgg.size === 1 ? "" : "s"} with violations across ${a.pagesAudited} audited page${a.pagesAudited === 1 ? "" : "s"}. Instances are DOM nodes flagged; pages are unique URLs in which the rule fired.`, { size: 22 }));
      parts.push(emptyParagraph());
      const ruleRows = [["Rule", "Impact", "Instances", "Pages", "Help"]];
      const ordered = [...ruleAgg.values()].sort((x, y) => y.instances - x.instances);
      for (const r of ordered) {
        ruleRows.push([r.id, r.impact, String(r.instances), String(r.pages.size), r.help]);
      }
      parts.push(table(ruleRows, { widths: [2200, 1000, 900, 900, 4600] }));
    }
  }
  parts.push(emptyParagraph());

  // Manual-test union
  parts.push(heading("8. Manual Test Matrix", 2));
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
  parts.push(heading("9. Assumptions and Exclusions", 2));
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
  parts.push(heading("10. Acceptance Criteria", 2));
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
  return z.finalize("application/vnd.openxmlformats-officedocument.wordprocessingml.document");
}
