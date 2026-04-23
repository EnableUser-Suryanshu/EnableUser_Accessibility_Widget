// GIGW 3.0 governance / structural checks that go beyond WCAG.
//
// GIGW is mostly WCAG 2.1 AA (which axe covers), but the guidelines also
// impose India-specific *governance* requirements that axe can't know about:
//
//   • Homepage <title> must identify the ministry/department AND include
//     "Government of India" (or appropriate state government identifier).
//     [GIGW section 3.1 — titling & identity]
//
//   • Every page should link to an accessibility statement — typically at
//     /accessibility-statement, /accessibility, or similar. [GIGW 4.1]
//
//   • PDF links should have a visible type/size hint and (ideally) a note
//     that the PDF has been OCR'd / is tagged for accessibility.
//     [GIGW 5.2.16 — images of text / OCR guidance]
//
//   • Skip-to-main-content link required (WCAG 2.4.1 bypass blocks, called
//     out specifically in GIGW 5.2.27).
//
//   • Language selector — bilingual (Hindi/English) toggle expected on
//     Union Government sites. [GIGW 4.3]
//
// These checks produce warnings (incomplete, not hard failures) because
// context-sensitive — a subdomain page isn't a homepage, a third-party
// embed might not need the skip link, etc. The auditor reviews.
//
// Exposed as window.EU_GIGWChecks.run(root).

(function () {
  const HOMEPAGE_PATHS = new Set(["", "/", "/index.html", "/home", "/home.html"]);

  function isLikelyHomepage() {
    try {
      const u = new URL(location.href);
      return HOMEPAGE_PATHS.has(u.pathname) || u.pathname === "";
    } catch { return false; }
  }

  function nodeFor(el, failure, impact = "moderate") {
    // No truncation — parity with axe-core pipeline.
    const html = el && el.outerHTML ? el.outerHTML : "<html>";
    const target = [el ? selectorFor(el) : "html"];
    return { html, target, xpath: [], ancestry: [], impact, failureSummary: failure, any: [], all: [], none: [] };
  }

  function selectorFor(el) {
    if (!el || el === document.documentElement) return "html";
    if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
    return el.tagName.toLowerCase();
  }

  // ─────────────────────────────────────────────────────────────────
  // Check 1 — Homepage title identity (GIGW §3.1)
  // ─────────────────────────────────────────────────────────────────
  function checkHomepageTitleIdentity() {
    if (!isLikelyHomepage()) return null;
    const title = (document.title || "").trim();
    if (!title) return null; // axe's document-title catches empty

    const lower = title.toLowerCase();
    const hasGovtMarker =
      /government of india/i.test(title) ||
      /govt\.? of india/i.test(title) ||
      /\|\s*gov(ernment)?\b/i.test(title) ||
      /\bgoi\b/i.test(title) ||
      /ministry of/i.test(title) ||
      /department of/i.test(title) ||
      /government of [a-z ]+/i.test(title); // state govts

    if (hasGovtMarker) return null;

    return {
      id: "gigw-homepage-title-identity",
      impact: "moderate",
      tags: ["gigw3", "is17802", "wcag242", "gigw-governance"],
      description: `Homepage <title> does not include a government/ministry identifier.`,
      help: `GIGW §3.1 requires the homepage title to identify the ministry/department and include "Government of India" (or equivalent state government identifier). Example: "Ministry of Health & Family Welfare | Government of India".`,
      helpUrl: "https://guidelines.india.gov.in/",
      nodes: [nodeFor(document.querySelector("title"), `Title: "${title}" — no ministry/government-of-india marker found.`)]
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Check 2 — Accessibility statement link present
  // ─────────────────────────────────────────────────────────────────
  function checkAccessibilityStatementLink() {
    const patterns = [
      /accessib/i,                         // "accessibility statement", "Accessibility"
      /सुगम्यता/,                            // Hindi: "accessibility"
      /उपयोगिता/                             // Hindi: "usability" (often used interchangeably)
    ];
    const PATH_HINTS = ["accessibility", "a11y", "access-statement"];

    const links = document.querySelectorAll("a[href]");
    for (const a of links) {
      const text = (a.innerText || a.textContent || a.getAttribute("aria-label") || "").trim();
      const href = (a.getAttribute("href") || "").toLowerCase();
      if (patterns.some(p => p.test(text))) return null;
      if (PATH_HINTS.some(h => href.includes(h))) return null;
    }

    return {
      id: "gigw-accessibility-statement-missing",
      impact: "moderate",
      tags: ["gigw3", "is17802", "gigw-governance"],
      description: `No link to an accessibility statement found on the page.`,
      help: `GIGW §4.1 requires a prominent link to an Accessibility Statement describing the site's conformance level, known limitations, and contact for accessibility feedback.`,
      helpUrl: "https://guidelines.india.gov.in/",
      nodes: [nodeFor(document.body, `Scanned ${links.length} link(s); none matched accessibility-statement patterns.`)]
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Check 3 — Skip-to-main-content link
  // ─────────────────────────────────────────────────────────────────
  function checkSkipLink() {
    // Typical skip link is the first/early focusable anchor pointing to #main
    // or #content, with text like "Skip to main content".
    const anchors = document.querySelectorAll('a[href^="#"]');
    for (const a of anchors) {
      const text = (a.innerText || a.textContent || "").toLowerCase();
      const href = (a.getAttribute("href") || "").toLowerCase();
      if (/skip/i.test(text) && /(main|content|navigation|nav)/i.test(text)) return null;
      if (["#main", "#content", "#maincontent", "#main-content", "#primary", "#body-content"].includes(href) && /skip|jump/i.test(text)) return null;
    }
    // Also accept role="navigation" landmarks WITH a <main> — axe's
    // landmark-one-main handles the main check; this is about the skip link.
    return {
      id: "gigw-skip-link-missing",
      impact: "moderate",
      tags: ["wcag241", "gigw3", "is17802", "gigw-governance"],
      description: `No "Skip to main content" link detected.`,
      help: `GIGW §5.2.27 (WCAG 2.4.1) requires a mechanism to bypass repeated blocks. The conventional implementation is a focusable anchor at the top of the page with text like "Skip to main content" pointing at the <main> element.`,
      helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/bypass-blocks",
      nodes: [nodeFor(document.body, `Scanned ${anchors.length} in-page anchor(s); no skip link matched.`)]
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Check 4 — PDF link without type/size hint
  // ─────────────────────────────────────────────────────────────────
  function checkPdfLinkHints() {
    const bad = [];
    document.querySelectorAll('a[href]').forEach(a => {
      const href = (a.getAttribute("href") || "").toLowerCase();
      if (!/\.pdf(\?|#|$)/.test(href)) return;
      const text = (a.innerText || a.textContent || a.getAttribute("aria-label") || "").toLowerCase();
      const hasTypeHint = /\bpdf\b/.test(text) || /\bopens.*pdf/i.test(text);
      const hasSizeHint = /\d+\s?(kb|mb|gb)/i.test(text);
      if (hasTypeHint && hasSizeHint) return;
      bad.push({ a, text, hasTypeHint, hasSizeHint });
    });
    if (!bad.length) return null;
    return {
      id: "gigw-pdf-link-hints-missing",
      impact: "minor",
      tags: ["gigw3", "is17802", "wcag244", "gigw-governance"],
      description: `${bad.length} PDF link(s) without visible type/size hint.`,
      help: `GIGW §5.2.16 / WCAG 2.4.4 — inform users that a link opens a PDF and its size. Example link text: "Annual Report 2025 (PDF, 2.3 MB)".`,
      helpUrl: "https://guidelines.india.gov.in/",
      nodes: bad.map(({ a, text, hasTypeHint, hasSizeHint }) => {
        const missing = [!hasTypeHint && "type", !hasSizeHint && "size"].filter(Boolean).join(" + ");
        return nodeFor(a, `Link to .pdf; missing ${missing} hint. Text: "${text.trim()}"`, "minor");
      })
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Check 5 — Bilingual language toggle (Hindi/English)
  // ─────────────────────────────────────────────────────────────────
  function checkLanguageToggle() {
    // Only flag on Union-Govt style sites — we approximate that by looking
    // for .gov.in hostnames (central government) or nic.in. State sites may
    // use different languages so we don't flag them.
    let host;
    try { host = new URL(location.href).hostname.toLowerCase(); } catch { return null; }
    if (!host.endsWith(".gov.in") && !host.endsWith(".nic.in")) return null;

    const links = document.querySelectorAll("a, button, [role='button'], select");
    for (const el of links) {
      const text = (el.innerText || el.textContent || el.getAttribute("aria-label") || "").trim().toLowerCase();
      if (/हिन्दी|हिंदी|hindi|\bhi\b|\ben\b|\bहिं\b/i.test(text)) return null;
      if (el.tagName === "SELECT") {
        for (const opt of el.querySelectorAll("option")) {
          const t = (opt.textContent || "").toLowerCase();
          if (/हिन्दी|हिंदी|hindi|english/.test(t)) return null;
        }
      }
    }

    return {
      id: "gigw-language-toggle-missing",
      impact: "minor",
      tags: ["gigw3", "is17802", "gigw-governance", "india-language"],
      description: `No visible Hindi/English language toggle on a .gov.in / .nic.in site.`,
      help: `GIGW §4.3 — Union Government websites should provide bilingual content with a Hindi/English language toggle in a prominent location (typically the masthead).`,
      helpUrl: "https://guidelines.india.gov.in/",
      nodes: [nodeFor(document.body, `Host ${host} — expected bilingual Hindi/English toggle.`)]
    };
  }

  function run() {
    const results = [];
    try {
      const c1 = checkHomepageTitleIdentity(); if (c1) results.push(c1);
      const c2 = checkAccessibilityStatementLink(); if (c2) results.push(c2);
      const c3 = checkSkipLink(); if (c3) results.push(c3);
      const c4 = checkPdfLinkHints(); if (c4) results.push(c4);
      const c5 = checkLanguageToggle(); if (c5) results.push(c5);
    } catch (err) {
      console.warn("[EU] gigw-checks error", err);
    }
    return results;
  }

  window.EU_GIGWChecks = { run };
})();
