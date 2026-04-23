// Media & document accessibility checks.
//
// Complements axe-core's built-in video-caption / audio-caption / frame-title
// rules with the things those rules don't cover:
//
//   • <video autoplay> without muted — WCAG 1.4.2 (Audio Control).
//   • Missing track[kind="descriptions"] on <video> — WCAG 1.2.5 (AD,
//     Prerecorded).
//   • Missing track[kind="captions"|"subtitles"] on <video> — WCAG 1.2.2
//     (re-asserted in a form we can attach to the right node; axe flags it
//     too for prerecorded video-with-audio, but we want it for ALL <video>
//     so the auditor can filter).
//   • <audio> without a nearby transcript link — WCAG 1.2.1 (Audio-only and
//     Video-only Prerecorded). Flagged as review, not violation.
//   • Embedded video iframes (YouTube / Vimeo / Wistia / Dailymotion /
//     JW Player) without title or aria-label — WCAG 4.1.2 (Name, Role,
//     Value). axe's frame-title rule catches some but not the vendor-
//     specific heuristic for "this is a video player, name must describe
//     the video".
//   • Links to PDF / Excel / Word / PowerPoint / CSV with generic text
//     ("click here", "download", "PDF") — WCAG 2.4.4 (Link Purpose).
//   • Same links missing a file-type / size hint — GIGW 5.2.16 guidance.
//   • Every linked PDF / Excel / Word document produces an INCOMPLETE
//     (review) finding so the auditor is reminded to verify document-level
//     accessibility (tagged PDF, alt text, heading structure, table
//     headers, etc.) — a web crawler can't audit that itself.
//
// Also exposes collect() which returns a flat inventory of every media
// and document item on the page (used by the report's Media & Documents
// section). Inventory entries carry their detected issues so the UI can
// show per-item findings without cross-referencing the rules array.
//
// Exposed as window.EU_MediaChecks.{ run, collect }.

(function () {
  const DOC_TYPES = {
    pdf:  { label: "PDF",          family: "pdf" },
    xlsx: { label: "Excel",        family: "spreadsheet" },
    xls:  { label: "Excel",        family: "spreadsheet" },
    xlsm: { label: "Excel (macro)",family: "spreadsheet" },
    csv:  { label: "CSV",          family: "spreadsheet" },
    ods:  { label: "OpenDocument Sheet", family: "spreadsheet" },
    docx: { label: "Word",         family: "document" },
    doc:  { label: "Word",         family: "document" },
    odt:  { label: "OpenDocument Text", family: "document" },
    rtf:  { label: "RTF",          family: "document" },
    pptx: { label: "PowerPoint",   family: "presentation" },
    ppt:  { label: "PowerPoint",   family: "presentation" },
    odp:  { label: "OpenDocument Presentation", family: "presentation" }
  };
  const DOC_EXTS = Object.keys(DOC_TYPES);
  const DOC_EXT_RE = new RegExp(`\\.(${DOC_EXTS.join("|")})(?:$|[?#])`, "i");

  // Words that by themselves make link text ambiguous about destination.
  // "Click here", "here", "download", "read more", "learn more", "link",
  // "pdf" (when that's the entire link text), "document", "file".
  const GENERIC_LINK_TEXT = new Set([
    "click here", "click", "here", "more", "read more", "learn more",
    "see more", "view", "view more", "link", "this link", "this", "download",
    "download here", "download file", "download pdf", "download document",
    "file", "document", "pdf", "excel", "xlsx", "xls", "doc", "docx", "ppt",
    "pptx", "csv", "zip", "open", "open file", "details", "info",
    // Hindi equivalents commonly seen on .gov.in sites
    "यहां", "यहाँ", "यहां क्लिक करें", "डाउनलोड", "देखें", "और देखें", "विस्तार"
  ]);

  // File-size hint regex — matches "(2.3 MB)", "[450 KB]", "· 1.2 GB" etc.
  const SIZE_HINT_RE = /\b\d+(?:[.,]\d+)?\s?(?:KB|MB|GB|kb|mb|gb)\b/;
  // File-type hint — a token like "PDF", "Excel", "Word", "XLSX" anywhere
  // in the link text or its nearby context.
  const TYPE_HINT_RE = /\b(?:PDF|XLSX?|XLSM|CSV|DOCX?|PPTX?|RTF|ODT|ODS|ODP|Excel|Word|PowerPoint|Spreadsheet|Presentation)\b/i;

  // Embedded-video hosts. Map hostname fragment → { vendor, label }.
  const VIDEO_HOSTS = [
    { test: /(^|\.)youtube\.com$|^youtu\.be$|(^|\.)youtube-nocookie\.com$/i, vendor: "youtube", label: "YouTube" },
    { test: /(^|\.)vimeo\.com$|(^|\.)player\.vimeo\.com$/i, vendor: "vimeo", label: "Vimeo" },
    { test: /(^|\.)wistia\.com$|(^|\.)wistia\.net$|(^|\.)fast\.wistia\.net$/i, vendor: "wistia", label: "Wistia" },
    { test: /(^|\.)dailymotion\.com$|(^|\.)dai\.ly$/i, vendor: "dailymotion", label: "Dailymotion" },
    { test: /(^|\.)jwplayer\.com$|(^|\.)jwpcdn\.com$/i, vendor: "jwplayer", label: "JW Player" },
    { test: /(^|\.)kaltura\.com$/i, vendor: "kaltura", label: "Kaltura" },
    { test: /(^|\.)brightcove\.(com|net)$/i, vendor: "brightcove", label: "Brightcove" },
    { test: /(^|\.)facebook\.com$/i, vendor: "facebook-video", label: "Facebook Video" }
  ];

  function absUrl(href) {
    try { return new URL(href, location.href).href; } catch { return href || ""; }
  }
  function hostOf(href) {
    try { return new URL(href, location.href).hostname; } catch { return ""; }
  }
  function extOf(href) {
    const m = (href || "").match(DOC_EXT_RE);
    return m ? m[1].toLowerCase() : "";
  }
  function textOf(el) {
    return ((el?.textContent || el?.innerText || "") + "").replace(/\s+/g, " ").trim();
  }
  function accessibleName(el) {
    if (!el) return "";
    // Priority: aria-labelledby > aria-label > title > <track kind="caption">
    // label > inner text > alt on nested image.
    const byId = el.getAttribute("aria-labelledby");
    if (byId) {
      const ids = byId.split(/\s+/);
      const names = ids.map(id => document.getElementById(id)).filter(Boolean).map(textOf);
      const joined = names.join(" ").trim();
      if (joined) return joined;
    }
    const al = (el.getAttribute("aria-label") || "").trim();
    if (al) return al;
    const ti = (el.getAttribute("title") || "").trim();
    if (ti) return ti;
    // Inside link? Fall through to textContent.
    const txt = textOf(el);
    if (txt) return txt;
    const img = el.querySelector?.("img[alt]");
    if (img && img.getAttribute("alt")) return img.getAttribute("alt").trim();
    return "";
  }
  function selectorFor(el) {
    if (!el) return "html";
    if (el === document.documentElement) return "html";
    if (el.id) return `${el.tagName.toLowerCase()}#${el.id}`;
    // Stable-ish selector: tag + first non-utility class token.
    const cls = (el.className || "").toString().split(/\s+/).filter(c => c && c.length < 40)[0];
    return cls ? `${el.tagName.toLowerCase()}.${CSS.escape(cls)}` : el.tagName.toLowerCase();
  }
  function nearbyContext(el, maxChars = 240) {
    // Walk up to the nearest block-ish parent and take its visible text. This
    // is what a sighted user would associate with the link — used to let the
    // rule give the auditor a real excerpt rather than just the link text.
    let p = el?.parentElement;
    let hops = 0;
    while (p && hops < 4) {
      if (/^(P|LI|TD|TH|DIV|SECTION|ARTICLE|FIGCAPTION|DT|DD)$/.test(p.tagName)) break;
      p = p.parentElement;
      hops++;
    }
    const t = textOf(p || el?.parentElement || el);
    return t.length > maxChars ? t.slice(0, maxChars) + "…" : t;
  }
  function firstNumericDuration(el) {
    // <video> / <audio> expose .duration (seconds) once loaded. Not guaranteed
    // at scan-time (media may not have loaded metadata), so we return null if
    // unavailable rather than blocking on a load event.
    try {
      const d = Number(el.duration);
      if (Number.isFinite(d) && d > 0) return d;
    } catch {}
    return null;
  }

  // Detect a sibling / nearby video element that appears to be an Indian
  // Sign Language (ISL) companion to the primary video `v`. IS 17802
  // Chapter 7 (Videos) + IIS usability guidance for public-sector sites
  // increasingly expect a separate ISL-interpreted video alongside the
  // main content — commonly rendered as a second <video> or embedded
  // <iframe> in the same container, labelled "ISL", "Indian Sign
  // Language", or "भारतीय सांकेतिक भाषा".
  //
  // We walk up to the nearest block container (figure/section/article/
  // div) and inspect OTHER media elements inside it. Positive signals:
  //   • lang / xml:lang attribute starting with "sgn" (IANA subtag for
  //     sign languages, e.g. sgn-IN = Indian Sign Language)
  //   • aria-label / title / visible text containing ISL / Indian Sign
  //     Language / सांकेतिक भाषा / भारतीय सांकेतिक
  //   • figcaption / caption text nearby containing those markers
  // False-positive cost is low — a sighted sign-language companion is a
  // safe thing to claim a site has. False-negative cost is also low —
  // the rule still runs as a review finding, not a hard violation.
  const ISL_LABEL_RE = /\b(?:isl|indian\s*sign\s*language|sign[-\s]*language\s*interpret)|भारतीय\s*सांकेतिक|सांकेतिक\s*भाषा/i;
  function detectIslCompanion(v) {
    if (!v) return false;
    // Nearest block-ish ancestor — same heuristic as nearbyContext.
    let scope = v.parentElement;
    let hops = 0;
    while (scope && hops < 5) {
      if (/^(FIGURE|SECTION|ARTICLE|DIV|MAIN|ASIDE)$/.test(scope.tagName)) break;
      scope = scope.parentElement;
      hops++;
    }
    if (!scope) return false;
    // Candidate companions: any OTHER <video> or video-embed <iframe>
    // inside the scope.
    const candidates = Array.from(scope.querySelectorAll("video, iframe[src], iframe[data-src]"))
      .filter(el => el !== v);
    for (const c of candidates) {
      const lang = (c.getAttribute("lang") || c.getAttribute("xml:lang") || "").toLowerCase();
      if (/^sgn(-|$)/i.test(lang)) return true;
      const label =
        (c.getAttribute("aria-label") || "") + " " +
        (c.getAttribute("title") || "") + " " +
        (c.getAttribute("data-label") || "");
      if (ISL_LABEL_RE.test(label)) return true;
      // Figcaption or adjacent caption for the candidate.
      const cap = c.closest("figure")?.querySelector("figcaption");
      if (cap && ISL_LABEL_RE.test(textOf(cap))) return true;
    }
    // Also accept a figcaption/caption directly under the scope that
    // names an ISL version, even if the companion media is loaded
    // lazily and not yet in the DOM.
    const scopeCaps = scope.querySelectorAll("figcaption, [class*=caption], [class*=label]");
    for (const cap of scopeCaps) {
      if (ISL_LABEL_RE.test(textOf(cap))) return true;
    }
    return false;
  }

  // Build an axe-shaped rule with a single node. We don't bother coalescing
  // same-rule hits into one rule with many nodes — each item's context is
  // different, and the report aggregates them upstream.
  function rule(ruleId, opts) {
    const {
      impact = "moderate",
      description,
      help,
      helpUrl = "",
      wcagTags = [],
      el,
      failureSummary,
      data = null
    } = opts;
    const html = el?.outerHTML ? el.outerHTML : "";
    const target = [el ? selectorFor(el) : "html"];
    return {
      id: ruleId,
      impact,
      tags: ["custom", "media", ...wcagTags],
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
  // Inventory builders — each produces a flat item with all fields
  // the report UI needs + an `issues` array of rule ids that apply.
  // ─────────────────────────────────────────────────────────────────

  function collectVideos() {
    const out = [];
    const vids = Array.from(document.querySelectorAll("video"));
    for (const v of vids) {
      const sources = [];
      const srcAttr = v.getAttribute("src");
      if (srcAttr) sources.push(absUrl(srcAttr));
      for (const s of v.querySelectorAll("source")) {
        const sr = s.getAttribute("src");
        if (sr) sources.push(absUrl(sr));
      }
      const tracks = Array.from(v.querySelectorAll("track")).map(t => ({
        kind: (t.getAttribute("kind") || "subtitles").toLowerCase(),
        srclang: t.getAttribute("srclang") || "",
        label: t.getAttribute("label") || "",
        src: t.getAttribute("src") ? absUrl(t.getAttribute("src")) : ""
      }));
      const hasCaptions = tracks.some(t => t.kind === "captions" || t.kind === "subtitles");
      const hasDescriptions = tracks.some(t => t.kind === "descriptions");
      // Sign-language detection — three signals in priority order:
      //   (a) <track kind="signs"|"sign-language"|"sign"> — rare but
      //       unambiguous when present.
      //   (b) <track> whose srclang or label explicitly names a sign
      //       language (sgn, sgn-IN for Indian Sign Language, ISL).
      //   (c) A companion video element nearby — a second <video> or
      //       embedded iframe in the same container whose accessible
      //       name / aria-label / title declares it as ISL / Indian Sign
      //       Language / भारतीय सांकेतिक भाषा / सांकेतिक भाषा, or whose
      //       element carries lang="sgn-IN" (the IANA subtag for ISL).
      // The check is conservative — we only set hasSignLanguage=true on
      // a positive signal. Absence on .gov.in / .nic.in surfaces as a
      // serious finding via videoRules; on other sites it's advisory.
      const hasSignLanguageTrack =
        tracks.some(t => ["signs", "sign", "sign-language"].includes(t.kind)) ||
        tracks.some(t => /^sgn(-|$)/i.test(t.srclang)) ||
        tracks.some(t => /\b(sign\s*language|isl|indian\s*sign)\b|सांकेतिक\s*भाषा/i.test(t.label));
      const hasSignLanguageCompanion = detectIslCompanion(v);
      const hasSignLanguage = hasSignLanguageTrack || hasSignLanguageCompanion;
      const autoplay = v.hasAttribute("autoplay");
      const muted = v.hasAttribute("muted") || v.muted === true;
      const controls = v.hasAttribute("controls");
      const name = accessibleName(v);
      const item = {
        kind: "video",
        subtype: "html5",
        url: sources[0] || v.currentSrc || "",
        sources,
        accessibleName: name,
        tracks,
        hasCaptions,
        hasDescriptions,
        hasSignLanguage,
        hasSignLanguageTrack,
        hasSignLanguageCompanion,
        hasControls: controls,
        autoplay,
        muted,
        durationSeconds: firstNumericDuration(v),
        element: v,
        selector: selectorFor(v),
        html: v.outerHTML.slice(0, 2000),
        issues: []
      };
      out.push(item);
    }
    return out;
  }

  function collectAudios() {
    const out = [];
    for (const a of document.querySelectorAll("audio")) {
      const sources = [];
      const srcAttr = a.getAttribute("src");
      if (srcAttr) sources.push(absUrl(srcAttr));
      for (const s of a.querySelectorAll("source")) {
        const sr = s.getAttribute("src");
        if (sr) sources.push(absUrl(sr));
      }
      const tracks = Array.from(a.querySelectorAll("track")).map(t => ({
        kind: (t.getAttribute("kind") || "subtitles").toLowerCase(),
        srclang: t.getAttribute("srclang") || "",
        label: t.getAttribute("label") || ""
      }));
      // Transcript heuristic: look at the element's immediate parent + next
      // sibling for a link whose text contains "transcript" or for a details
      // element with "transcript" in its summary. It's a heuristic — flagged
      // as review either way.
      const hasTranscript = (() => {
        const scope = a.closest("figure, section, article, div") || a.parentElement || a;
        if (!scope) return false;
        const links = scope.querySelectorAll("a, summary, button");
        for (const l of links) {
          if (/transcript/i.test(textOf(l))) return true;
        }
        return false;
      })();
      const autoplay = a.hasAttribute("autoplay");
      const muted = a.hasAttribute("muted") || a.muted === true;
      const controls = a.hasAttribute("controls");
      const name = accessibleName(a);
      out.push({
        kind: "audio",
        subtype: "html5",
        url: sources[0] || a.currentSrc || "",
        sources,
        accessibleName: name,
        tracks,
        hasCaptions: tracks.some(t => t.kind === "captions" || t.kind === "subtitles"),
        hasTranscript,
        hasControls: controls,
        autoplay,
        muted,
        durationSeconds: firstNumericDuration(a),
        element: a,
        selector: selectorFor(a),
        html: a.outerHTML.slice(0, 2000),
        issues: []
      });
    }
    return out;
  }

  function collectEmbeddedVideos() {
    const out = [];
    const iframes = Array.from(document.querySelectorAll("iframe[src], iframe[data-src]"));
    for (const f of iframes) {
      const src = f.getAttribute("src") || f.getAttribute("data-src") || "";
      if (!src) continue;
      const host = hostOf(src);
      const vendor = VIDEO_HOSTS.find(v => v.test.test(host));
      if (!vendor) continue;
      const title = (f.getAttribute("title") || "").trim();
      const ariaLabel = (f.getAttribute("aria-label") || "").trim();
      const ariaLbl = f.getAttribute("aria-labelledby");
      const labelled = ariaLbl
        ? ariaLbl.split(/\s+/).map(id => document.getElementById(id)).filter(Boolean).map(textOf).join(" ").trim()
        : "";
      const name = title || ariaLabel || labelled;
      out.push({
        kind: "iframe-video",
        subtype: vendor.vendor,
        vendorLabel: vendor.label,
        url: absUrl(src),
        accessibleName: name,
        title,
        ariaLabel,
        ariaLabelledby: labelled,
        element: f,
        selector: selectorFor(f),
        html: f.outerHTML.slice(0, 1500),
        issues: []
      });
    }
    // <object> / <embed> for rarer video embeds.
    for (const obj of document.querySelectorAll("object[type], embed[type]")) {
      const type = (obj.getAttribute("type") || "").toLowerCase();
      if (!/video|flash|x-shockwave/.test(type)) continue;
      const dataUrl = obj.getAttribute("data") || obj.getAttribute("src") || "";
      out.push({
        kind: "iframe-video",
        subtype: "object",
        vendorLabel: "Embedded object",
        url: absUrl(dataUrl),
        accessibleName: accessibleName(obj),
        title: obj.getAttribute("title") || "",
        ariaLabel: obj.getAttribute("aria-label") || "",
        ariaLabelledby: "",
        element: obj,
        selector: selectorFor(obj),
        html: obj.outerHTML.slice(0, 1500),
        issues: []
      });
    }
    return out;
  }

  function collectDocumentLinks() {
    const out = [];
    const links = Array.from(document.querySelectorAll("a[href]"));
    for (const a of links) {
      const href = a.getAttribute("href") || "";
      if (!href || href.startsWith("#") || href.startsWith("javascript:") || href.startsWith("mailto:") || href.startsWith("tel:")) continue;
      const ext = extOf(href);
      if (!ext) continue;
      const type = DOC_TYPES[ext];
      if (!type) continue;
      const linkText = textOf(a) || a.getAttribute("aria-label") || a.getAttribute("title") || "";
      const normLinkText = linkText.toLowerCase().trim();
      const context = nearbyContext(a);
      const hasTypeHint =
        TYPE_HINT_RE.test(linkText) ||
        TYPE_HINT_RE.test(a.getAttribute("aria-label") || "") ||
        TYPE_HINT_RE.test(a.getAttribute("title") || "");
      const hasSizeHint =
        SIZE_HINT_RE.test(linkText) ||
        SIZE_HINT_RE.test(context) ||
        SIZE_HINT_RE.test(a.getAttribute("aria-label") || "") ||
        SIZE_HINT_RE.test(a.getAttribute("title") || "");
      const isGeneric =
        !linkText ||
        GENERIC_LINK_TEXT.has(normLinkText) ||
        GENERIC_LINK_TEXT.has(normLinkText.replace(/[.!…]+$/, "")) ||
        normLinkText.length < 4;
      const opensInNewTab = a.getAttribute("target") === "_blank";
      const hasNewTabNotice =
        /opens? in (?:a )?new (?:tab|window)/i.test(linkText) ||
        /opens? in (?:a )?new (?:tab|window)/i.test(a.getAttribute("aria-label") || "") ||
        /opens? in (?:a )?new (?:tab|window)/i.test(a.getAttribute("title") || "");
      out.push({
        kind: "document",
        subtype: ext,
        family: type.family,
        typeLabel: type.label,
        url: absUrl(href),
        linkText,
        context,
        ariaLabel: a.getAttribute("aria-label") || "",
        titleAttr: a.getAttribute("title") || "",
        hasTypeHint,
        hasSizeHint,
        isGenericLinkText: isGeneric,
        opensInNewTab,
        hasNewTabNotice,
        element: a,
        selector: selectorFor(a),
        html: a.outerHTML.slice(0, 1500),
        issues: []
      });
    }
    return out;
  }

  // ─────────────────────────────────────────────────────────────────
  // Rule emitters — turn inventory items into axe-shaped rules, and
  // record each matched ruleId on the item's `issues` array so the
  // report UI can show per-item findings without cross-referencing.
  // ─────────────────────────────────────────────────────────────────

  function videoRules(items) {
    const rules = [];
    for (const v of items) {
      if (!v.hasCaptions) {
        v.issues.push("media-video-captions");
        rules.push(rule("media-video-captions", {
          impact: "serious",
          description: "Video is missing captions or subtitles.",
          help: "Add a <track kind=\"captions\"> (or \"subtitles\") element inside <video> that points to a WebVTT captions file synchronised with the audio track. Required for any video that carries spoken content.",
          helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/captions-prerecorded.html",
          wcagTags: ["wcag2a", "wcag122", "cat.media"],
          el: v.element,
          failureSummary: `Video${v.accessibleName ? " \"" + v.accessibleName + "\"" : ""} has no <track kind=\"captions\"|\"subtitles\">. Captions are required by WCAG 1.2.2 (prerecorded) and 1.2.4 (live).`,
          data: { src: v.url, tracks: v.tracks }
        }));
      }
      if (!v.hasDescriptions) {
        // Audio description is Level AA (1.2.5). Flagged as review because a
        // purely decorative / silent video doesn't need AD.
        v.issues.push("media-video-audio-description");
        rules.push(rule("media-video-audio-description", {
          impact: "moderate",
          description: "Video has no audio description track (review).",
          help: "If the video conveys meaningful visual information not already spoken in the audio, add an audio description track (<track kind=\"descriptions\">) or provide an alternative version with audio description. Review to confirm applicability.",
          helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/audio-description-prerecorded.html",
          wcagTags: ["wcag2aa", "wcag125", "cat.media", "review"],
          el: v.element,
          failureSummary: "No <track kind=\"descriptions\"> track found. WCAG 1.2.5 requires audio description for prerecorded video; confirm whether this video carries visual-only content.",
          data: { src: v.url, tracks: v.tracks }
        }));
      }
      if (v.autoplay && !v.muted) {
        v.issues.push("media-video-autoplay");
        rules.push(rule("media-video-autoplay", {
          impact: "serious",
          description: "Video autoplays with sound and no mechanism to pause.",
          help: "Either remove the autoplay attribute, add muted to start muted, or add a controls attribute so users can pause within 3 seconds. WCAG 1.4.2 requires audio that plays automatically for more than 3 seconds to have a stop/pause mechanism.",
          helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/audio-control.html",
          wcagTags: ["wcag2a", "wcag142", "cat.media"],
          el: v.element,
          failureSummary: "<video autoplay> without muted. Playing audio without user intent fails WCAG 1.4.2 if duration > 3s.",
          data: { autoplay: true, muted: false, controls: v.hasControls, src: v.url }
        }));
      }
      if (!v.hasControls && !v.autoplay) {
        // Without controls AND without autoplay, users can't start the video
        // at all unless a custom JS player is driving it. We can't detect
        // custom players reliably, so flag as review.
        v.issues.push("media-video-controls");
        rules.push(rule("media-video-controls", {
          impact: "moderate",
          description: "Video has no controls attribute and no custom player detected (review).",
          help: "Either add the controls attribute or confirm that a custom JS player exposes keyboard-operable play/pause/seek/volume controls with proper ARIA labels. WCAG 2.1.1 + 4.1.2.",
          helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/keyboard.html",
          wcagTags: ["wcag2a", "wcag211", "wcag412", "cat.media", "review"],
          el: v.element,
          failureSummary: "<video> missing controls and autoplay. If no custom player wraps this element, the video cannot be started by the user.",
          data: { src: v.url }
        }));
      }
      if (!v.accessibleName) {
        v.issues.push("media-video-name");
        rules.push(rule("media-video-name", {
          impact: "serious",
          description: "Video has no accessible name.",
          help: "Add an aria-label, aria-labelledby, or title attribute that describes the video, or place the video inside a <figure> with a <figcaption>. Required by WCAG 4.1.2 so assistive tech can announce what the player is.",
          helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html",
          wcagTags: ["wcag2a", "wcag412", "cat.name-role-value"],
          el: v.element,
          failureSummary: "<video> has no aria-label, aria-labelledby, or title. Screen readers will announce only the element role.",
          data: { src: v.url }
        }));
      }
      // IS 17802 Chapter 7 — sign-language interpretation of prerecorded
      // video. Where the host site is a public-sector / government
      // property the Indian Information Service usability guidance
      // (and IS 17802 Ch 7 itself) calls for an ISL companion for
      // official audio-video content. We detect ABSENCE of the signal
      // and emit as "moderate + review" — the auditor still has to
      // confirm the video carries speech that warrants sign-language
      // interpretation (a silent animation doesn't).
      if (!v.hasSignLanguage) {
        v.issues.push("media-video-sign-language-missing");
        rules.push(rule("media-video-sign-language-missing", {
          impact: "moderate",
          description: "Video has no Indian Sign Language (ISL) companion or sign-language track (review).",
          help: "For prerecorded video carrying speech — and especially on government / public-service sites covered by IS 17802 Chapter 7 — provide a sign-language interpretation. Acceptable forms: a <track kind=\"signs\"> element, a <track> with srclang=\"sgn-IN\" (ISL), or a companion video in the same container labelled \"ISL\" / \"Indian Sign Language\" / \"भारतीय सांकेतिक भाषा\" or carrying lang=\"sgn-IN\". IS 17802 Chapter 7 and WCAG 1.2.6 (Sign Language, Prerecorded, AAA) set this expectation.",
          helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/sign-language-prerecorded.html",
          wcagTags: ["is17802-ch7", "wcag126", "cat.media", "review"],
          el: v.element,
          failureSummary: "No sign-language track, no sgn-* srclang/label, and no nearby ISL-labelled companion video found. Confirm whether the video carries speech that requires sign-language interpretation under IS 17802 Ch 7.",
          data: { src: v.url, tracks: v.tracks, hasSignLanguageTrack: v.hasSignLanguageTrack, hasSignLanguageCompanion: v.hasSignLanguageCompanion }
        }));
      }
    }
    return rules;
  }

  function audioRules(items) {
    const rules = [];
    for (const a of items) {
      if (!a.hasTranscript) {
        a.issues.push("media-audio-transcript");
        rules.push(rule("media-audio-transcript", {
          impact: "moderate",
          description: "Audio has no nearby transcript link (review).",
          help: "Provide a text transcript of the audio content. The transcript should be linked from a location adjacent to the audio element so the connection is clear. WCAG 1.2.1 requires a text alternative for prerecorded audio-only content.",
          helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/audio-only-and-video-only-prerecorded.html",
          wcagTags: ["wcag2a", "wcag121", "cat.media", "review"],
          el: a.element,
          failureSummary: "No link or <details> element matching \"transcript\" found near this <audio>. Auditor to confirm an alternative text version exists.",
          data: { src: a.url }
        }));
      }
      if (a.autoplay && !a.muted) {
        a.issues.push("media-audio-autoplay");
        rules.push(rule("media-audio-autoplay", {
          impact: "serious",
          description: "Audio autoplays and no mechanism to pause is declared.",
          help: "Remove the autoplay attribute, add muted, or ensure the element has controls. WCAG 1.4.2 requires audio playing automatically for more than 3 seconds to have a stop / pause mechanism.",
          helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/audio-control.html",
          wcagTags: ["wcag2a", "wcag142", "cat.media"],
          el: a.element,
          failureSummary: "<audio autoplay> without muted.",
          data: { src: a.url, controls: a.hasControls }
        }));
      }
      if (!a.accessibleName) {
        a.issues.push("media-audio-name");
        rules.push(rule("media-audio-name", {
          impact: "serious",
          description: "Audio has no accessible name.",
          help: "Add aria-label, aria-labelledby, or title that identifies the audio content (speaker, topic, date).",
          helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html",
          wcagTags: ["wcag2a", "wcag412", "cat.name-role-value"],
          el: a.element,
          failureSummary: "<audio> has no aria-label / aria-labelledby / title.",
          data: { src: a.url }
        }));
      }
    }
    return rules;
  }

  function iframeVideoRules(items) {
    const rules = [];
    for (const it of items) {
      if (!it.accessibleName) {
        it.issues.push("media-iframe-video-title");
        rules.push(rule("media-iframe-video-title", {
          impact: "serious",
          description: `Embedded ${it.vendorLabel || "video"} iframe has no title or aria-label.`,
          help: `Add a title attribute on the <iframe> that names the specific video (e.g., "Citizen services overview — Ministry of Electronics & IT"). Generic titles like "YouTube video player" fail WCAG 4.1.2 because they don't identify the content.`,
          helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html",
          wcagTags: ["wcag2a", "wcag412", "cat.name-role-value"],
          el: it.element,
          failureSummary: `${it.vendorLabel || "Embedded video"} iframe has no title / aria-label / aria-labelledby. Screen-reader users hear only "frame".`,
          data: { src: it.url, vendor: it.subtype }
        }));
      } else if (/^(youtube|vimeo) video player$/i.test(it.accessibleName)) {
        // Vendor default title that doesn't actually name the video.
        it.issues.push("media-iframe-video-title-generic");
        rules.push(rule("media-iframe-video-title-generic", {
          impact: "moderate",
          description: `Embedded video iframe uses the generic vendor title "${it.accessibleName}".`,
          help: "Replace the default vendor title with one that names the actual video content. Vendor defaults like \"YouTube video player\" don't satisfy WCAG 4.1.2's requirement that the name describe the content.",
          helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/name-role-value.html",
          wcagTags: ["wcag2a", "wcag412", "cat.name-role-value"],
          el: it.element,
          failureSummary: `Iframe title \"${it.accessibleName}\" is a vendor default, not a description of this specific video.`,
          data: { src: it.url, vendor: it.subtype, title: it.accessibleName }
        }));
      }
    }
    return rules;
  }

  function documentRules(items) {
    const rules = [];
    for (const d of items) {
      if (d.isGenericLinkText) {
        d.issues.push("media-doc-link-purpose");
        rules.push(rule("media-doc-link-purpose", {
          impact: "serious",
          description: `${d.typeLabel} link has generic or missing text: "${d.linkText || "(empty)"}".`,
          help: `The link text should describe what the ${d.typeLabel} contains — not "click here", "download", or the file extension by itself. WCAG 2.4.4 requires link purpose to be determinable from the link text (with or without context).`,
          helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context.html",
          wcagTags: ["wcag2a", "wcag244", "cat.semantics"],
          el: d.element,
          failureSummary: `Link text "${d.linkText}" does not describe the document. File: ${d.url}.`,
          data: { url: d.url, linkText: d.linkText, typeLabel: d.typeLabel }
        }));
      }
      if (!d.hasTypeHint) {
        d.issues.push("media-doc-type-hint");
        rules.push(rule("media-doc-type-hint", {
          impact: "minor",
          description: `${d.typeLabel} link does not indicate the file format.`,
          help: `Include "${d.typeLabel}" (or a recognisable extension like ".${d.subtype}") in the link text, aria-label, or visible icon label. GIGW 5.2.16 and the WCAG Techniques advisory G189 recommend declaring non-HTML formats so users know what will open.`,
          helpUrl: "https://guidelines.india.gov.in/accessibility-guidelines-and-attributes/",
          wcagTags: ["gigw3", "wcag244", "advisory"],
          el: d.element,
          failureSummary: `No "${d.typeLabel}" / ".${d.subtype}" marker in link text or accessible name.`,
          data: { url: d.url, linkText: d.linkText, typeLabel: d.typeLabel }
        }));
      }
      if (!d.hasSizeHint) {
        d.issues.push("media-doc-size-hint");
        rules.push(rule("media-doc-size-hint", {
          impact: "minor",
          description: `${d.typeLabel} link does not indicate the file size.`,
          help: "Include a size indicator such as \"(2.3 MB)\" so users on metered connections or assistive tech users can decide whether to open. Advisory under GIGW 5.2.16 and WCAG G189.",
          helpUrl: "https://guidelines.india.gov.in/accessibility-guidelines-and-attributes/",
          wcagTags: ["gigw3", "advisory"],
          el: d.element,
          failureSummary: "No KB/MB/GB size declared in link text, aria-label, or nearby context.",
          data: { url: d.url, linkText: d.linkText }
        }));
      }
      if (d.opensInNewTab && !d.hasNewTabNotice) {
        d.issues.push("media-doc-new-tab-notice");
        rules.push(rule("media-doc-new-tab-notice", {
          impact: "minor",
          description: `${d.typeLabel} link opens in a new tab without warning.`,
          help: "Links with target=\"_blank\" should indicate \"opens in a new tab\" in the accessible name or visually. Otherwise focus management, back-button expectation, and screen-reader orientation break.",
          helpUrl: "https://www.w3.org/WAI/WCAG21/Techniques/general/G201",
          wcagTags: ["wcag2aa", "wcag322", "advisory"],
          el: d.element,
          failureSummary: "target=\"_blank\" without \"opens in a new tab\" in link text or aria-label.",
          data: { url: d.url, linkText: d.linkText }
        }));
      }

      // Manual-audit review flag for EVERY document regardless of link quality.
      // A web crawler cannot audit a PDF's /StructTreeRoot, /Lang, /Title,
      // alt text on images, table headers, or reading order. Surface each
      // document as an incomplete-review item so the audit plan includes it.
      const reviewId = d.family === "pdf" ? "media-pdf-manual-audit"
                    : d.family === "spreadsheet" ? "media-spreadsheet-manual-audit"
                    : d.family === "presentation" ? "media-presentation-manual-audit"
                    : "media-document-manual-audit";
      d.issues.push(reviewId);
      rules.push(rule(reviewId, {
        impact: "minor",
        description: `${d.typeLabel} document requires manual accessibility audit (review).`,
        help:
          d.family === "pdf"
            ? "PDF: verify tagged structure (/StructTreeRoot), document language (/Lang), document title in metadata, alt text on images and figures, correct heading nesting, logical reading order, table headers, bookmarks for documents > 9 pages, text-based (not scanned image) content, form field labels if interactive. WCAG 1.3.1, 1.1.1, 2.4.2, 2.4.6, 3.1.1, 4.1.2."
            : d.family === "spreadsheet"
            ? "Spreadsheet: verify table headers (row 1 and/or column A with header styles), sheet names meaningful, alt text on embedded images/charts, colour-only-encoding avoided, merged cells minimised, named ranges for data tables, hidden rows/columns documented. WCAG 1.3.1, 1.4.1, 1.1.1."
            : d.family === "presentation"
            ? "Presentation: verify each slide has a unique title, reading order set explicitly, alt text on images, colour contrast ≥ 4.5:1 for text, no text in images-of-text without equivalent, slide layouts used correctly, transitions not triggering seizures. WCAG 1.3.1, 1.4.3, 1.1.1, 2.3.1."
            : "Document: verify heading structure, alt text on images, language declared, table headers, link text descriptive. WCAG 1.3.1, 1.1.1, 3.1.1, 2.4.4.",
        helpUrl:
          d.family === "pdf"
            ? "https://www.w3.org/WAI/WCAG2/Techniques/pdf/"
            : "https://www.w3.org/WAI/WCAG21/Techniques/",
        wcagTags: ["wcag2a", "wcag131", "cat.structure", "review"],
        el: d.element,
        failureSummary: `${d.typeLabel} linked at ${d.url} — content accessibility cannot be verified from the HTML host page. Open the file and audit against the listed criteria.`,
        data: { url: d.url, typeLabel: d.typeLabel, subtype: d.subtype, family: d.family }
      }));
    }
    return rules;
  }

  // ─────────────────────────────────────────────────────────────────

  function collect() {
    const videos = collectVideos();
    const audios = collectAudios();
    const iframeVideos = collectEmbeddedVideos();
    const documents = collectDocumentLinks();
    // Run rule emitters so each inventory item gets its `issues` populated.
    const rules = [
      ...videoRules(videos),
      ...audioRules(audios),
      ...iframeVideoRules(iframeVideos),
      ...documentRules(documents)
    ];
    // Strip the live DOM reference before returning — it isn't cloneable for
    // structured-clone across chrome.runtime.sendMessage and we don't need it
    // on the background side.
    const sanitize = (arr) => arr.map(({ element, ...rest }) => rest);
    return {
      rules,
      inventory: {
        videos: sanitize(videos),
        audios: sanitize(audios),
        iframeVideos: sanitize(iframeVideos),
        documents: sanitize(documents)
      }
    };
  }

  function run(/* root = document */) {
    return collect().rules;
  }
  function inventory() {
    return collect().inventory;
  }

  window.EU_MediaChecks = { run, collect, inventory };
})();
