// India-specific accessibility checks — regional language + script handling.
//
// These extend axe-core's WCAG coverage with checks IS 17802 calls out
// explicitly (India's unique linguistic profile) that axe's generic
// implementation doesn't catch well:
//   • A page containing substantial Devanagari/Bengali/Tamil/... text where
//     <html lang="…"> points at a script-incompatible language.
//   • A paragraph of English with an inline Devanagari run but no per-passage
//     lang switch (WCAG 3.1.2 / IS 17802 9.3.1.2).
//   • RTL content (Urdu, Arabic) rendered without dir="rtl".
//
// Output shape mirrors axe-core so content-script.js can merge the results
// straight into the violations/incomplete arrays — same keys for rules
// (id, impact, tags, description, help, helpUrl, nodes[]).
//
// Exposed as window.EU_IndiaChecks.run(root) so it's callable from the
// content-script after injection via chrome.scripting.

(function () {
  // Unicode ranges for the 22 Eighth Schedule languages + common scripts.
  // Source ranges: Unicode 15.0 script blocks.
  const SCRIPTS = [
    { name: "Devanagari",    lang: "hi",  script: "Deva", range: /[\u0900-\u097F]/g, rtl: false,
      langs: ["hi", "mr", "ne", "sa", "kok", "bho", "mai", "doi", "brx", "sat"] },
    { name: "Bengali",       lang: "bn",  script: "Beng", range: /[\u0980-\u09FF]/g, rtl: false,
      langs: ["bn", "as", "mni"] },
    { name: "Gurmukhi",      lang: "pa",  script: "Guru", range: /[\u0A00-\u0A7F]/g, rtl: false,
      langs: ["pa"] },
    { name: "Gujarati",      lang: "gu",  script: "Gujr", range: /[\u0A80-\u0AFF]/g, rtl: false,
      langs: ["gu"] },
    { name: "Oriya",         lang: "or",  script: "Orya", range: /[\u0B00-\u0B7F]/g, rtl: false,
      langs: ["or"] },
    { name: "Tamil",         lang: "ta",  script: "Taml", range: /[\u0B80-\u0BFF]/g, rtl: false,
      langs: ["ta"] },
    { name: "Telugu",        lang: "te",  script: "Telu", range: /[\u0C00-\u0C7F]/g, rtl: false,
      langs: ["te"] },
    { name: "Kannada",       lang: "kn",  script: "Knda", range: /[\u0C80-\u0CFF]/g, rtl: false,
      langs: ["kn"] },
    { name: "Malayalam",     lang: "ml",  script: "Mlym", range: /[\u0D00-\u0D7F]/g, rtl: false,
      langs: ["ml"] },
    // Urdu / Kashmiri written in Arabic script (Perso-Arabic Nastaʿlīq).
    { name: "Arabic/Urdu",   lang: "ur",  script: "Arab",
      range: /[\u0600-\u06FF\u0750-\u077F\uFB50-\uFDFF\uFE70-\uFEFF]/g, rtl: true,
      langs: ["ur", "ks", "ar", "fa", "ps", "sd"] }
  ];

  // Minimum run of same-script chars in ONE node's direct text before we
  // treat it as "substantial". Single diacritic artefacts, user names, etc.
  // don't deserve a violation.
  const MIN_CHARS = 4;

  function textOf(el) {
    // We want the *direct* text content of this element, not descendants —
    // descendants are handled by their own iteration. This catches the
    // common mixed-language pattern cleanly.
    let s = "";
    for (const n of el.childNodes) if (n.nodeType === 3) s += n.nodeValue || "";
    return s;
  }

  function nearestLang(el) {
    let cur = el;
    while (cur && cur !== document.documentElement) {
      const lg = cur.getAttribute && cur.getAttribute("lang");
      if (lg) return lg.toLowerCase().split("-")[0];
      cur = cur.parentElement;
    }
    const html = document.documentElement;
    return (html.getAttribute("lang") || "").toLowerCase().split("-")[0];
  }

  function nearestDir(el) {
    let cur = el;
    while (cur) {
      const d = cur.getAttribute && cur.getAttribute("dir");
      if (d) return d.toLowerCase();
      cur = cur.parentElement;
    }
    return (window.getComputedStyle(document.body).direction || "ltr").toLowerCase();
  }

  function selectorFor(el) {
    // Cheap-and-cheerful CSS selector, enough to uniquely identify the node
    // in the report. Axe produces richer selectors but we only need a lead.
    if (!el || el === document.documentElement) return "html";
    const parts = [];
    let cur = el;
    while (cur && cur.nodeType === 1 && parts.length < 5) {
      let p = cur.tagName.toLowerCase();
      if (cur.id) { p += `#${cur.id}`; parts.unshift(p); break; }
      if (cur.className && typeof cur.className === "string") {
        const cls = cur.className.trim().split(/\s+/).filter(c => c && !/\d{4,}/.test(c)).slice(0, 2);
        if (cls.length) p += "." + cls.join(".");
      }
      parts.unshift(p);
      cur = cur.parentElement;
    }
    return parts.join(" > ");
  }

  function nodeFor(el, failure) {
    // No truncation — parity with the axe-core pipeline which keeps full html.
    const html = el.outerHTML || "";
    return {
      html,
      target: [selectorFor(el)],
      xpath: [],
      ancestry: [],
      impact: "serious",
      failureSummary: failure,
      any: [], all: [], none: []
    };
  }

  function countScriptChars(str, range) {
    const m = str.match(range);
    return m ? m.length : 0;
  }

  // Check 1 — Devanagari/other-script content on a page whose top-level lang
  // doesn't match the script being used.
  function checkPageScriptLangMismatch() {
    const htmlLang = (document.documentElement.getAttribute("lang") || "").toLowerCase().split("-")[0];
    const body = document.body;
    if (!body) return null;

    const totalText = (body.innerText || "");
    const scriptCounts = {};
    for (const s of SCRIPTS) scriptCounts[s.script] = countScriptChars(totalText, s.range);

    // Pick the dominant non-Latin script on the page.
    const dominant = Object.entries(scriptCounts)
      .filter(([, n]) => n >= MIN_CHARS * 20) // page-level: require meaningful presence
      .sort((a, b) => b[1] - a[1])[0];

    if (!dominant) return null;

    const [scriptKey] = dominant;
    const meta = SCRIPTS.find(s => s.script === scriptKey);
    if (!meta) return null;

    if (meta.langs.includes(htmlLang)) return null; // lang matches the script → OK

    return {
      id: "india-page-lang-script-mismatch",
      impact: "serious",
      tags: ["wcag311", "is17802", "india-language", "wcag2a", "wcag21aa"],
      description: `Page appears to contain ${meta.name} (${scriptKey}) text but <html lang> is "${htmlLang || "(unset)"}" — expected one of: ${meta.langs.join(", ")}.`,
      help: `Set <html lang="..."> to match the dominant script. IS 17802 requires the page language to be programmatically determinable (WCAG 3.1.1).`,
      helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/language-of-page",
      nodes: [nodeFor(document.documentElement,
        `Dominant script on page is ${meta.name}; expected lang one of ${meta.langs.join(", ")} but got "${htmlLang || "(none)"}".`)]
    };
  }

  // Check 2 — passage-level language switching. Find text-bearing elements
  // where the *direct* text contains a substantial run of a script that
  // doesn't match the nearest lang ancestor.
  function checkPassageLangMismatch() {
    const out = [];
    const TEXT_TAGS = "p, li, td, th, h1, h2, h3, h4, h5, h6, figcaption, dt, dd, blockquote, div, span, article, section, a, button, label";
    const seen = new Set();

    document.querySelectorAll(TEXT_TAGS).forEach(el => {
      const txt = textOf(el);
      if (!txt || txt.length < MIN_CHARS) return;
      for (const s of SCRIPTS) {
        const n = countScriptChars(txt, s.range);
        if (n < MIN_CHARS) continue;
        const lang = nearestLang(el);
        if (s.langs.includes(lang)) continue; // nearest lang matches script
        const key = `${selectorFor(el)}|${s.script}`;
        if (seen.has(key)) return;
        seen.add(key);
        out.push({ el, script: s, lang, chars: n });
        break;
      }
    });

    if (!out.length) return null;
    return {
      id: "india-passage-lang-switch-missing",
      impact: "moderate",
      tags: ["wcag312", "is17802", "india-language", "wcag21aa"],
      description: `Inline text in a non-matching script detected — each passage should wrap its script switch in an element with lang="..." (WCAG 3.1.2).`,
      help: `Wrap the foreign-script run in <span lang="xx"> where xx matches the language (e.g. lang="hi" for Devanagari-Hindi, lang="ta" for Tamil).`,
      helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/language-of-parts",
      nodes: out.map(({ el, script, lang, chars }) =>
        nodeFor(el, `Contains ~${chars} ${script.name} char(s); nearest lang is "${lang || "(none)"}" (expected one of ${script.langs.join(", ")}).`))
    };
  }

  // Check 3 — RTL script (Urdu/Arabic) rendered with dir="ltr" (inherited or
  // explicit). Without dir="rtl" the visual order is wrong even if the lang
  // attribute is set correctly.
  function checkRtlDirection() {
    const out = [];
    const seen = new Set();
    const TEXT_TAGS = "p, li, td, th, h1, h2, h3, h4, h5, h6, div, span, article, section, blockquote";

    document.querySelectorAll(TEXT_TAGS).forEach(el => {
      const txt = textOf(el);
      if (!txt) return;
      const rtlScript = SCRIPTS.find(s => s.rtl && countScriptChars(txt, s.range) >= MIN_CHARS);
      if (!rtlScript) return;
      const dir = nearestDir(el);
      if (dir === "rtl" || dir === "auto") return;
      const key = selectorFor(el);
      if (seen.has(key)) return;
      seen.add(key);
      out.push({ el, script: rtlScript, dir });
    });

    if (!out.length) return null;
    return {
      id: "india-rtl-direction-missing",
      impact: "serious",
      tags: ["wcag134", "is17802", "india-language", "wcag21aa"],
      description: `RTL-script content rendered without dir="rtl" — visual order will be wrong for Urdu/Arabic/Kashmiri.`,
      help: `Set dir="rtl" on the element or an ancestor containing RTL-script content. Use dir="auto" if mixing directions.`,
      helpUrl: "https://www.w3.org/International/articles/inline-bidi-markup/",
      nodes: out.map(({ el, script, dir }) =>
        nodeFor(el, `Element contains ${script.name} (RTL) text but effective dir is "${dir}".`))
    };
  }

  // Check 4 — if any Indian-script text exists at all on the page, verify
  // that the chosen font-family actually declares support for that script
  // in CSS. We can't detect this perfectly (browsers fall back to system
  // fonts), but we can at least note it as "needs manual review" when the
  // computed font-family is a generic Latin family.
  function checkFontCoverage() {
    const out = [];
    const LATIN_ONLY_FAMILIES = [
      "times new roman", "arial", "helvetica", "verdana", "georgia",
      "courier new", "tahoma", "palatino", "garamond", "trebuchet ms"
    ];
    document.querySelectorAll("p, h1, h2, h3, h4, h5, h6, li").forEach(el => {
      const txt = textOf(el);
      if (!txt) return;
      const hasIndian = SCRIPTS.some(s => !s.rtl && s.script !== "Arab" && countScriptChars(txt, s.range) >= MIN_CHARS);
      if (!hasIndian) return;
      const family = (window.getComputedStyle(el).fontFamily || "").toLowerCase();
      // Check the FIRST family only — that's what the browser will attempt first.
      const first = family.split(",")[0].replace(/['"]/g, "").trim();
      if (LATIN_ONLY_FAMILIES.includes(first)) {
        out.push({ el, family: first });
      }
    });
    if (!out.length) return null;
    return {
      id: "india-font-script-coverage",
      impact: "minor",
      tags: ["wcag141", "is17802", "india-language", "review"],
      description: `Indian-script text is being styled with a Latin-only font family — visual rendering depends on browser fallback and may degrade.`,
      help: `Declare an Indian-script-capable font first in font-family (e.g. "Noto Sans Devanagari", "Mangal") or use a webfont with explicit Unicode-range covering the script.`,
      helpUrl: "https://fonts.google.com/noto",
      nodes: out.map(({ el, family }) =>
        nodeFor(el, `Indian-script text with first font-family "${family}" — no script coverage declared.`))
    };
  }

  function run(/* root */) {
    const results = [];
    try {
      const c1 = checkPageScriptLangMismatch(); if (c1) results.push(c1);
      const c2 = checkPassageLangMismatch();    if (c2) results.push(c2);
      const c3 = checkRtlDirection();            if (c3) results.push(c3);
      const c4 = checkFontCoverage();            if (c4) results.push(c4);
    } catch (err) {
      // Fail soft — one broken check shouldn't torpedo the whole scan.
      console.warn("[EU] india-checks error", err);
    }
    return results;
  }

  window.EU_IndiaChecks = { run };
})();
