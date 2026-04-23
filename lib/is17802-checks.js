// IS 17802 site-governance checks — things that are NOT strictly WCAG
// 2.1 web-content rules but that IS 17802 Part 1 expects a web
// property to provide:
//
//   • Chapter 10 — Non-web documents. We flag linked PDFs/Office in
//     media-checks.js already; this file adds *positive* signals —
//     when the site offers the same content in multiple formats
//     (HTML + PDF + DOCX), record it so the report can credit that.
//
//   • Chapter 12 — Documentation and support. The site must publish
//     an accessibility statement that names a standard, a review
//     date, a contact, and a feedback channel. gigw-checks detects
//     whether the LINK exists anywhere on the page. Here we validate
//     the STATEMENT CONTENT when the current page is the accessibility
//     statement itself (detected from URL + title + h1).
//
//   • Chapter 13 — ICT services supporting relay / emergency comms.
//     For web this maps to: a published contact channel (toll-free /
//     TTY / TRS-compatible number, email, or feedback form) that a
//     user with a communication disability can reach. We surface
//     hints; auditor verifies applicability.
//
// All findings are emitted as review/moderate unless a specific
// WCAG criterion is cleanly violated. The aim is to give the
// auditor a punch-list, not to fake automated conformance for
// chapters that require human review.
//
// Exposed as window.EU_Is17802Checks.{ run, collect }.

(function () {
  // URL patterns that suggest this page IS an accessibility statement.
  // We stay broad — "/accessibility", "/accessibility-statement",
  // "/accessibility-policy", "/sulabhata" (Hindi), etc.
  const STATEMENT_URL_RE = /\/(?:accessibility(?:[-_]?statement|[-_]?policy|[-_]?declaration|[-_]?help)?|a11y(?:[-_]?statement)?|sulabhata|पहुँच)(?:[\/?#]|$)/i;
  // Title / H1 tokens that indicate an accessibility statement page.
  const STATEMENT_TITLE_RE = /\b(accessibility\s*(statement|policy|declaration|help|notice)|a11y\s*statement)\b|अभिगम्यता|सुगम्यता|पहुँच\s*कथन/i;

  // Standards names we count as a "named standard" claim in the
  // statement body. IS 17802 Ch 12 wants the statement to declare
  // which standard the site targets and its conformance level.
  const STANDARD_NAMES_RE = /\b(WCAG\s*2\.\d(?:\s*(?:A{1,3}|Level\s*A{1,3}))?|IS\s*17802|GIGW\s*3|EN\s*301\s*549|Section\s*508|ADA)\b/i;

  // Conformance-level claim.
  const CONFORMANCE_LEVEL_RE = /\b(?:level\s*)?(?:A|AA|AAA)\b(?:\s*(?:conformance|conformant|compliant|compliance))?|partially\s*(?:conform|compliant)|fully\s*(?:conform|compliant)/i;

  // Last-reviewed / last-updated date pattern. Very loose — we want
  // any plausible date anywhere in the statement body.
  const DATE_RE = /\b(20\d{2})(?:[-\/]\d{1,2}[-\/]\d{1,2})?\b|\b(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}\b|\b\d{1,2}\s+(?:January|February|March|April|May|June|July|August|September|October|November|December)\s+20\d{2}\b/i;

  // Contact / feedback words in English + Hindi.
  const CONTACT_RE = /\b(?:contact|email|feedback|grievance|complaint|helpdesk|help\s*desk|support|report(?:\s+a)?\s+(?:problem|issue|barrier)|accessibility\s+(?:team|officer|coordinator))\b|संपर्क|शिकायत|फ़ीडबैक|प्रतिक्रिया|सहायता/i;

  // Tel / TTY / toll-free cues for Ch 13 relay-service mapping.
  const RELAY_RE = /\b(?:TTY|TRS|text\s*relay|national\s*relay|india\s*relay|toll[-\s]*free|1[-\s]?800[-\s\d]{6,}|सहायता\s*क्रमांक)\b|\btel:[+\d\-\s()]+/i;

  // Email regex (loose).
  const EMAIL_RE = /\b[a-z0-9._%+\-]+@[a-z0-9.\-]+\.[a-z]{2,}\b/i;

  // Multi-format clusters — same base filename with different extensions
  // are likely the same content offered in multiple formats.
  const MULTI_FORMAT_EXTS = ["pdf", "docx", "doc", "odt", "html", "htm", "txt"];

  function textOf(el) {
    return ((el?.textContent || "") + "").replace(/\s+/g, " ").trim();
  }
  function selectorFor(el) {
    if (!el) return "html";
    if (el === document.documentElement) return "html";
    if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
    const cls = (el.className || "").toString().split(/\s+/).filter(c => c && c.length < 40)[0];
    return cls ? `${el.tagName.toLowerCase()}.${CSS.escape(cls)}` : el.tagName.toLowerCase();
  }

  function rule(ruleId, opts) {
    const {
      impact = "moderate",
      description,
      help,
      helpUrl = "",
      tags = [],
      el = document.documentElement,
      failureSummary,
      data = null
    } = opts;
    const html = el?.outerHTML ? el.outerHTML.slice(0, 1000) : "";
    const target = [selectorFor(el)];
    return {
      id: ruleId,
      impact,
      tags: ["custom", "is17802", ...tags],
      description,
      help,
      helpUrl,
      nodes: [{
        html,
        target,
        xpath: [],
        ancestry: [],
        impact,
        failureSummary: failureSummary || description,
        any: [],
        all: [],
        none: [{
          id: ruleId,
          impact,
          message: failureSummary || description,
          data,
          relatedNodes: []
        }]
      }]
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Accessibility statement page detection + content validation.
  // ─────────────────────────────────────────────────────────────────

  function isAccessibilityStatementPage() {
    const url = location.href;
    const path = location.pathname || "";
    if (STATEMENT_URL_RE.test(path)) return "url";
    const title = (document.title || "").trim();
    if (STATEMENT_TITLE_RE.test(title)) return "title";
    const h1 = document.querySelector("h1");
    if (h1 && STATEMENT_TITLE_RE.test(textOf(h1))) return "h1";
    // Last resort — a <main> or article with a heading matching.
    const main = document.querySelector("main h1, main h2, article h1, article h2");
    if (main && STATEMENT_TITLE_RE.test(textOf(main))) return "heading";
    return null;
  }

  function collectStatementContentIssues() {
    const detected = isAccessibilityStatementPage();
    if (!detected) return { present: false, rules: [], data: null };

    // Scope the content scan to <main> if present, else <body>, to
    // avoid false matches from global header/footer.
    const scope = document.querySelector("main, [role=main], article") || document.body;
    const body = textOf(scope);
    const rules = [];

    const mentionsStandard = STANDARD_NAMES_RE.test(body);
    const mentionsLevel = CONFORMANCE_LEVEL_RE.test(body);
    const mentionsDate = DATE_RE.test(body);
    const mentionsContact = CONTACT_RE.test(body);
    const hasEmail = EMAIL_RE.test(body);
    const hasTel = /tel:[+\d\-\s()]+/i.test(scope.innerHTML || "") || /\b\+?\d[\d\-\s]{6,}\d/.test(body);
    // Feedback mechanism — a form, a contact link, a mailto, or a tel.
    const feedbackLink = scope.querySelector("a[href^='mailto:'], a[href^='tel:'], form, a[href*='feedback'], a[href*='contact'], a[href*='grievance']");
    const hasFeedbackMechanism = !!feedbackLink || hasEmail || hasTel;

    if (!mentionsStandard) {
      rules.push(rule("is17802-statement-missing-standard", {
        impact: "serious",
        description: "Accessibility statement does not name a conformance standard.",
        help: "The statement should explicitly name the standard it targets — WCAG 2.1, IS 17802, GIGW 3.0, EN 301 549, Section 508, or ADA. IS 17802 Chapter 12 and GIGW 3.0 Clause 4.2.1 require the statement to identify the technical standard and version being claimed.",
        helpUrl: "https://guidelines.india.gov.in/accessibility-guidelines-and-attributes/",
        tags: ["is17802-ch12", "gigw3", "governance"],
        el: scope,
        failureSummary: "No mention of WCAG, IS 17802, GIGW, EN 301 549, Section 508, or ADA found in the statement body.",
        data: { url: location.href, detectedBy: detected }
      }));
    }
    if (!mentionsLevel) {
      rules.push(rule("is17802-statement-missing-level", {
        impact: "moderate",
        description: "Accessibility statement does not declare a conformance level.",
        help: "State the level of conformance (A, AA, or AAA) and whether it is full, partial, or with exceptions. Absence makes the statement unverifiable — a user cannot tell what to expect.",
        helpUrl: "https://www.w3.org/WAI/planning/statements/",
        tags: ["is17802-ch12", "governance"],
        el: scope,
        failureSummary: "No 'Level A/AA/AAA' or 'partial/full conformance' claim found in the statement body.",
        data: { url: location.href }
      }));
    }
    if (!mentionsDate) {
      rules.push(rule("is17802-statement-missing-date", {
        impact: "moderate",
        description: "Accessibility statement has no last-reviewed or last-updated date.",
        help: "Include a 'Last reviewed' / 'Last updated' date so users know the claim is current. IS 17802 Ch 12 expects statements to be kept current; undated statements cannot be relied on.",
        helpUrl: "https://www.w3.org/WAI/planning/statements/",
        tags: ["is17802-ch12", "governance"],
        el: scope,
        failureSummary: "No year / month-year / dd-month-yyyy date pattern found in the statement body.",
        data: { url: location.href }
      }));
    }
    if (!mentionsContact) {
      rules.push(rule("is17802-statement-missing-contact-mention", {
        impact: "serious",
        description: "Accessibility statement does not mention a contact / feedback / grievance channel.",
        help: "Name a team, officer, or inbox that users can reach for accessibility concerns. IS 17802 Ch 12 + GIGW 4.4 require a documented contact route for accessibility issues.",
        helpUrl: "https://guidelines.india.gov.in/accessibility-guidelines-and-attributes/",
        tags: ["is17802-ch12", "gigw3", "governance"],
        el: scope,
        failureSummary: "No contact/feedback/grievance/helpdesk keyword found in English or Hindi.",
        data: { url: location.href }
      }));
    }
    if (!hasFeedbackMechanism) {
      rules.push(rule("is17802-statement-missing-feedback-link", {
        impact: "serious",
        description: "Accessibility statement has no reachable feedback mechanism (mailto, tel, contact form, or link to a feedback page).",
        help: "Add at least one concrete feedback channel — an email (mailto:), a phone number (tel:), an embedded contact form, or a link to /contact or /feedback. A contact section without a working link/form is not reachable by keyboard users who cannot copy a visual address.",
        helpUrl: "https://www.w3.org/WAI/planning/statements/",
        tags: ["is17802-ch12", "is17802-ch13", "governance"],
        el: scope,
        failureSummary: "No <a href=mailto:>, <a href=tel:>, <form>, or /contact|/feedback|/grievance link found in the statement body.",
        data: { url: location.href, hasEmail, hasTel }
      }));
    }

    return {
      present: true,
      detectedBy: detected,
      rules,
      data: {
        mentionsStandard,
        mentionsLevel,
        mentionsDate,
        mentionsContact,
        hasFeedbackMechanism,
        hasEmail,
        hasTel,
        url: location.href
      }
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Feedback channel detection on ANY page (Ch 12 + Ch 13).
  // ─────────────────────────────────────────────────────────────────

  function collectFeedbackChannelSignals() {
    const doc = document;
    const anchors = Array.from(doc.querySelectorAll("a[href]"));
    const mailLinks = [];
    const telLinks = [];
    const contactLinks = [];
    const feedbackLinks = [];
    const grievanceLinks = [];
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      if (/^mailto:/i.test(href)) mailLinks.push({ href, text: textOf(a) });
      else if (/^tel:/i.test(href)) telLinks.push({ href, text: textOf(a) });
      else if (/\/contact(?:[\/?#]|$)/i.test(href)) contactLinks.push({ href, text: textOf(a) });
      else if (/\/feedback(?:[\/?#]|$)/i.test(href)) feedbackLinks.push({ href, text: textOf(a) });
      else if (/\/grievance|शिकायत/i.test(href)) grievanceLinks.push({ href, text: textOf(a) });
    }
    const bodyText = textOf(document.body || document.documentElement);
    const hasTollFree = /\b1[-\s]?800[-\s\d]{6,}/i.test(bodyText);
    const hasRelayMention = RELAY_RE.test(bodyText);
    return {
      mailLinks, telLinks, contactLinks, feedbackLinks, grievanceLinks,
      hasTollFree, hasRelayMention
    };
  }

  // ─────────────────────────────────────────────────────────────────
  // Multi-format coverage — positive signal for Ch 10 compliance.
  // ─────────────────────────────────────────────────────────────────

  function collectMultiFormatClusters() {
    const anchors = Array.from(document.querySelectorAll("a[href]"));
    const byBase = new Map(); // baseName → Set(ext)
    for (const a of anchors) {
      const href = a.getAttribute("href") || "";
      const m = href.match(/([^\/?#]+?)\.([a-z0-9]{2,5})(?:[?#]|$)/i);
      if (!m) continue;
      const base = m[1].toLowerCase();
      const ext = m[2].toLowerCase();
      if (!MULTI_FORMAT_EXTS.includes(ext)) continue;
      if (!byBase.has(base)) byBase.set(base, new Set());
      byBase.get(base).add(ext);
    }
    const clusters = [];
    for (const [base, set] of byBase.entries()) {
      if (set.size >= 2) clusters.push({ base, formats: [...set].sort() });
    }
    return clusters;
  }

  // ─────────────────────────────────────────────────────────────────

  function collect() {
    const statement = collectStatementContentIssues();
    const feedback = collectFeedbackChannelSignals();
    const multiFormat = collectMultiFormatClusters();

    const rules = [];
    rules.push(...statement.rules);

    // Ch 13 relay-service-friendly contact: if the site has no
    // mailto/tel/contact/feedback/grievance link AT ALL on this page
    // AND no toll-free number in body text, surface a review so the
    // auditor checks whether *some* page (usually /contact) offers a
    // reachable channel. This is broad — it'll fire on every landing
    // page that isn't a contact page — but gets de-duped at the
    // crawl-report level by clustering on rule id. Emitted as review,
    // not violation.
    const hasAnyContact = feedback.mailLinks.length + feedback.telLinks.length +
      feedback.contactLinks.length + feedback.feedbackLinks.length +
      feedback.grievanceLinks.length > 0;
    if (!hasAnyContact && !feedback.hasTollFree) {
      rules.push(rule("is17802-no-feedback-channel-on-page", {
        impact: "minor",
        description: "No feedback or contact channel reachable from this page (review).",
        help: "IS 17802 Ch 12 + Ch 13 expect every page to provide a way to reach the organisation — a header/footer link to /contact or /feedback, a mailto:, a tel:, or a toll-free number. Auditor: verify the site's global navigation carries such a link.",
        helpUrl: "https://guidelines.india.gov.in/accessibility-guidelines-and-attributes/",
        tags: ["is17802-ch12", "is17802-ch13", "governance", "review"],
        el: document.documentElement,
        failureSummary: "No mailto:, tel:, /contact, /feedback, /grievance link or 1-800 toll-free number found anywhere on this page.",
        data: { url: location.href }
      }));
    }

    // Positive signal — multi-format content coverage.
    // Emitted as a zero-impact info rule so the report can credit it.
    if (multiFormat.length > 0) {
      rules.push(rule("is17802-multi-format-content-positive", {
        impact: "minor",
        description: `Positive signal: ${multiFormat.length} content item${multiFormat.length === 1 ? "" : "s"} offered in multiple formats.`,
        help: "IS 17802 Ch 10 treats availability of the same content in multiple formats (HTML + PDF + DOCX, etc.) as a positive conformance indicator — users can pick the format their assistive tech handles best. No action required; this is informational.",
        helpUrl: "https://guidelines.india.gov.in/accessibility-guidelines-and-attributes/",
        tags: ["is17802-ch10", "info", "positive"],
        el: document.documentElement,
        failureSummary: `Same base filename found in: ${multiFormat.slice(0, 5).map(c => c.formats.join("/")).join(", ")}${multiFormat.length > 5 ? " …" : ""}.`,
        data: { clusters: multiFormat.slice(0, 50) }
      }));
    }

    return {
      rules,
      site: {
        isAccessibilityStatementPage: statement.present,
        statementContent: statement.data,
        feedbackSignals: {
          mailLinkCount: feedback.mailLinks.length,
          telLinkCount: feedback.telLinks.length,
          contactLinkCount: feedback.contactLinks.length,
          feedbackLinkCount: feedback.feedbackLinks.length,
          grievanceLinkCount: feedback.grievanceLinks.length,
          hasTollFree: feedback.hasTollFree,
          hasRelayMention: feedback.hasRelayMention,
          sampleMail: feedback.mailLinks.slice(0, 3),
          sampleTel: feedback.telLinks.slice(0, 3),
          sampleContact: feedback.contactLinks.slice(0, 3),
          sampleFeedback: feedback.feedbackLinks.slice(0, 3),
          sampleGrievance: feedback.grievanceLinks.slice(0, 3)
        },
        multiFormatClusterCount: multiFormat.length,
        multiFormatClusters: multiFormat.slice(0, 50)
      }
    };
  }

  function run(/* root = document */) {
    return collect().rules;
  }

  window.EU_Is17802Checks = { run, collect };
})();
