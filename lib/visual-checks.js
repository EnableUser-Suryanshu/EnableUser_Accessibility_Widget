// v0.4.6 — Visual-state checks: the machine-detectable subset of the manual
// checklist (link colour-only detection, focus-indicator suppression, hover/
// focus cue presence). These are the SCs axe is weak at because they live in
// pseudo-states and style *decisions* rather than the DOM.
//
// Machine-assists these Manual Checklist v1.2 cases:
//   C-02 — Body links: decide the route (non-colour cue present → Route A)
//   C-03 — Route B: link colour reaches 3:1 vs surrounding text
//   C-04 — Route B: a non-colour cue appears on hover AND focus (CSSOM scan)
//   K-02 — Every focus stop has a visible indicator (detects the global
//          outline:none reset with no replacement — the classic cause)
//
// What it deliberately does NOT claim: pseudo-states can't be computed from
// JS, so hover/focus findings are emitted as "review" (→ Incomplete) for the
// auditor to confirm, never as hard violations. Only the two provable cases
// (colour-only link below 3:1 in the DEFAULT state; a global :focus
// outline-kill with no compensating indicator anywhere) are violations.
//
// The non-colour-cue definition used throughout: a visual difference that
// SURVIVES GRAYSCALE. A background highlight counts only if its lightness
// differs from the surrounding background (luminance ratio ≥ 1.2) — a
// hue-only tint that grayscales to the same value is not a cue.
//
// Output shape mirrors axe-core (id, impact, tags, description, help,
// helpUrl, nodes[]) so content-script.js merges it like the other suites.
// Exposed as window.EU_VisualChecks.run(root).

(function () {
  const MAX_LINKS_ANALYZED = 300;
  const MAX_NODES_PER_RULE = 25;

  // ── colour math (WCAG relative luminance + contrast ratio) ─────────────
  function parseColor(str) {
    const m = /rgba?\(\s*(\d+)\s*,\s*(\d+)\s*,\s*(\d+)\s*(?:,\s*([\d.]+)\s*)?\)/.exec(str || "");
    if (!m) return null;
    return { r: +m[1], g: +m[2], b: +m[3], a: m[4] === undefined ? 1 : +m[4] };
  }
  function luminance(c) {
    const f = (v) => { v /= 255; return v <= 0.04045 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4); };
    return 0.2126 * f(c.r) + 0.7152 * f(c.g) + 0.0722 * f(c.b);
  }
  function contrast(c1, c2) {
    if (!c1 || !c2) return null;
    const l1 = luminance(c1), l2 = luminance(c2);
    const [hi, lo] = l1 >= l2 ? [l1, l2] : [l2, l1];
    return (hi + 0.05) / (lo + 0.05);
  }
  // Composite a possibly-transparent colour over a base (for rgba text/bg).
  function composite(fg, bg) {
    if (!fg) return bg;
    if (fg.a >= 1 || !bg) return fg;
    const a = fg.a;
    return { r: fg.r * a + bg.r * (1 - a), g: fg.g * a + bg.g * (1 - a), b: fg.b * a + bg.b * (1 - a), a: 1 };
  }
  function effectiveBackground(el) {
    let cur = el;
    while (cur && cur.nodeType === 1) {
      const c = parseColor(getComputedStyle(cur).backgroundColor);
      if (c && c.a > 0.01) return c;
      cur = cur.parentElement;
    }
    return { r: 255, g: 255, b: 255, a: 1 }; // assume white canvas
  }

  function selectorFor(el) {
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
  function nodeFor(el, failure, impact) {
    return {
      html: (el.outerHTML || "").slice(0, 4000),
      target: [selectorFor(el)],
      xpath: [], ancestry: [],
      impact: impact || "serious",
      failureSummary: failure,
      any: [], all: [], none: []
    };
  }

  // ── CSSOM walk: collect every style rule (flattening @media) ────────────
  function allStyleRules() {
    const out = [];
    for (const sheet of document.styleSheets) {
      let rules = null;
      try { rules = sheet.cssRules; } catch { continue; } // cross-origin
      if (!rules) continue;
      const walk = (list) => {
        for (const r of list) {
          if (r.type === 1) out.push(r);                       // CSSStyleRule
          else if (r.cssRules) { try { walk(r.cssRules); } catch {} } // @media, @supports
        }
      };
      try { walk(rules); } catch {}
    }
    return out;
  }

  const PSEUDO_RX = /:(hover|focus-visible|focus-within|focus|active|visited)/g;
  function selectorBaseMatches(el, selectorText) {
    for (const sel of String(selectorText || "").split(",")) {
      if (!PSEUDO_RX.test(sel)) { PSEUDO_RX.lastIndex = 0; continue; }
      PSEUDO_RX.lastIndex = 0;
      const base = sel.replace(PSEUDO_RX, "").trim();
      PSEUDO_RX.lastIndex = 0;
      if (!base || base === "*") return true;
      try { if (el.matches(base)) return true; } catch {}
    }
    return false;
  }

  // Does this rule's declaration block introduce a visible cue?
  function ruleAddsCue(style) {
    try {
      const td = style.getPropertyValue("text-decoration") + style.getPropertyValue("text-decoration-line");
      if (/underline|overline|line-through/.test(td)) return true;
      const bs = style.getPropertyValue("box-shadow");
      if (bs && bs !== "none") return true;
      const ol = style.getPropertyValue("outline") + style.getPropertyValue("outline-style");
      if (ol && !/none|^0(px)?$/.test(ol.trim())) return true;
      for (const p of ["border", "border-bottom", "border-bottom-width", "background", "background-color", "font-weight"]) {
        const v = style.getPropertyValue(p);
        if (v && v !== "none" && v !== "0px" && v !== "normal" && v !== "transparent") return true;
      }
    } catch {}
    return false;
  }
  function ruleKillsOutline(style) {
    try {
      const o = (style.getPropertyValue("outline") || "").trim();
      const os = (style.getPropertyValue("outline-style") || "").trim();
      const ow = (style.getPropertyValue("outline-width") || "").trim();
      return o === "none" || o === "0" || o === "0px" || os === "none" || ow === "0px" || ow === "0";
    } catch { return false; }
  }

  // ── Check 1: links in text blocks — 1.4.1 route analysis ───────────────
  function checkLinksColorOnly(styleRules) {
    const colorOnlyFails = [];   // provable: no cue + <3:1 vs surrounding text
    const routeBReview = [];     // colour-only but ≥3:1 — hover/focus cue not found in CSSOM
    const anchors = document.querySelectorAll("a[href]");
    let analyzed = 0;

    for (const a of anchors) {
      if (analyzed >= MAX_LINKS_ANALYZED) break;
      if (!a.getClientRects().length) continue; // invisible
      const text = (a.textContent || "").trim();
      if (!text) continue; // image links etc. — different rules
      // Link-in-text-block heuristic: the nearest block ancestor carries
      // meaningfully more text than the link itself.
      const block = a.closest("p, li, td, dd, blockquote, figcaption") ||
        (a.parentElement && /^(span|div)$/i.test(a.parentElement.tagName) ? a.parentElement : null);
      if (!block) continue;
      const blockText = (block.textContent || "").trim();
      if (blockText.length < text.length + 15) continue; // standalone link (nav/button-style) — exempt
      analyzed++;

      const s = getComputedStyle(a);
      const ps = getComputedStyle(block);

      // Non-colour cues in the DEFAULT state (Route A):
      const underlined = /underline|overline|line-through/.test(s.textDecorationLine || s.textDecoration);
      const bordered = s.borderBottomStyle !== "none" && parseFloat(s.borderBottomWidth) > 0;
      const bolder = (parseInt(s.fontWeight, 10) || 400) >= (parseInt(ps.fontWeight, 10) || 400) + 200;
      const italic = s.fontStyle === "italic" && ps.fontStyle !== "italic";
      // Background highlight counts only if it survives grayscale.
      const linkBgRaw = parseColor(s.backgroundColor);
      const surroundBg = effectiveBackground(block);
      const bgCue = linkBgRaw && linkBgRaw.a > 0.01 &&
        (contrast(composite(linkBgRaw, surroundBg), surroundBg) || 1) >= 1.2;

      if (underlined || bordered || bolder || italic || bgCue) continue; // Route A — done

      // Route B: colour is the only default-state cue.
      const linkColor = composite(parseColor(s.color), surroundBg);
      const textColor = composite(parseColor(ps.color), surroundBg);
      const ratio = contrast(linkColor, textColor);
      if (ratio !== null && ratio < 3) {
        if (colorOnlyFails.length < MAX_NODES_PER_RULE) {
          colorOnlyFails.push(nodeFor(a,
            `Link is distinguished from the surrounding text by colour alone, and the colour difference is only ${ratio.toFixed(2)}:1 (needs 3:1). ` +
            `Fix: add an underline (preferred), or raise the colour difference to 3:1 AND add a hover+focus cue.`, "serious"));
        }
        continue;
      }
      // ≥3:1 — legal only if a non-colour cue appears on hover AND focus.
      const hoverCue = styleRules.some(r => /:hover/.test(r.selectorText || "") && selectorBaseMatches(a, r.selectorText) && ruleAddsCue(r.style));
      const focusCue = styleRules.some(r => /:focus/.test(r.selectorText || "") && selectorBaseMatches(a, r.selectorText) && ruleAddsCue(r.style));
      if ((!hoverCue || !focusCue) && routeBReview.length < MAX_NODES_PER_RULE) {
        routeBReview.push(nodeFor(a,
          `Colour-only link (${ratio === null ? "?" : ratio.toFixed(2)}:1 vs surrounding text, ≥3:1 ✓) but no ${!hoverCue && !focusCue ? "hover or focus" : (!hoverCue ? "hover" : "focus")} ` +
          `cue rule was found in the page CSS. Route B (G183) requires a non-colour cue on hover AND focus. Verify manually — the cue may come from JS or an inaccessible stylesheet.`, "moderate"));
      }
    }

    const rules = [];
    if (colorOnlyFails.length) {
      rules.push({
        id: "eu-link-color-only",
        impact: "serious",
        tags: ["wcag2a", "wcag141", "EU-visual"],
        description: "Links in text blocks must not rely on colour alone with under 3:1 colour difference (WCAG 1.4.1, G183). [Manual Checklist C-02/C-03]",
        help: "Add an underline to body links, or ensure 3:1 colour difference plus hover and focus cues",
        helpUrl: "https://www.w3.org/WAI/WCAG21/Techniques/general/G183",
        nodes: colorOnlyFails
      });
    }
    if (routeBReview.length) {
      rules.push({
        id: "eu-link-route-b-states",
        impact: "moderate",
        tags: ["wcag2a", "wcag141", "EU-visual", "review"],
        description: "Colour-only links passed the 3:1 colour-difference bar but no hover/focus cue rule was found — Route B needs both (WCAG 1.4.1). [Manual Checklist C-04]",
        help: "Verify a non-colour cue (underline, background, border) appears on hover AND on focus",
        helpUrl: "https://www.w3.org/WAI/WCAG21/Techniques/general/G183",
        nodes: routeBReview
      });
    }
    return rules;
  }

  // ── Check 2: focus indicator suppression — 2.4.7 ───────────────────────
  function checkFocusSuppression(styleRules) {
    const killers = [];      // rules that remove the outline
    let replacementSeen = false; // ANY :focus/:focus-visible rule that adds a cue
    for (const r of styleRules) {
      const sel = r.selectorText || "";
      if (!/:focus/.test(sel)) continue;
      if (ruleAddsCue(r.style)) { replacementSeen = true; continue; }
      if (ruleKillsOutline(r.style)) killers.push(r);
    }
    if (!killers.length) return [];

    const globalKillers = killers.filter(r => /(^|\s|,)\*?:focus/.test(r.selectorText) || /^\s*\*\s*:focus/.test(r.selectorText));
    const list = (globalKillers.length ? globalKillers : killers).slice(0, MAX_NODES_PER_RULE);
    const nodes = list.map(r => ({
      html: `<style>${(r.cssText || "").slice(0, 500)}</style>`,
      target: [r.selectorText || "stylesheet rule"],
      xpath: [], ancestry: [],
      impact: replacementSeen ? "moderate" : "serious",
      failureSummary: replacementSeen
        ? `This rule removes the focus outline (${r.selectorText}). Other :focus rules in the CSS do add indicators — verify EVERY focusable element still shows one (tab through the page).`
        : `This rule removes the focus outline (${r.selectorText}) and no compensating :focus/:focus-visible indicator rule was found anywhere in the page CSS. Keyboard users cannot see where they are.`,
      any: [], all: [], none: []
    }));

    return [{
      id: replacementSeen ? "eu-focus-outline-review" : "eu-focus-suppressed",
      impact: replacementSeen ? "moderate" : "serious",
      tags: replacementSeen
        ? ["wcag2aa", "wcag247", "EU-visual", "review"]
        : ["wcag2aa", "wcag247", "EU-visual"],
      description: replacementSeen
        ? "CSS removes focus outlines on some selectors while other rules add indicators — coverage must be verified per element (WCAG 2.4.7). [Manual Checklist K-02]"
        : "CSS removes focus outlines with no replacement indicator anywhere — the classic *:focus{outline:none} reset (WCAG 2.4.7). [Manual Checklist K-02]",
      help: "Never remove the focus outline without a visible replacement (outline, box-shadow, or border on :focus-visible)",
      helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/focus-visible.html",
      nodes
    }];
  }

  // ── Check 3: no hover feedback on links — advisory only ────────────────
  // NOT a WCAG failure (no SC requires a hover state to exist; 2.4.7 requires
  // focus, which Check 2 covers). Emitted as a minor review item because the
  // team specifically tracks "hovering a link changes nothing" as a UX defect.
  function checkNoHoverFeedback(styleRules) {
    const anchors = [...document.querySelectorAll("a[href]")].filter(a => a.getClientRects().length && (a.textContent || "").trim());
    if (!anchors.length) return [];
    const sample = anchors.slice(0, 100);
    const noHover = [];
    for (const a of sample) {
      const has = styleRules.some(r => /:hover/.test(r.selectorText || "") && selectorBaseMatches(a, r.selectorText));
      if (!has && noHover.length < MAX_NODES_PER_RULE) {
        noHover.push(nodeFor(a, "No :hover rule in the page CSS matches this link — hovering it changes nothing. Not a WCAG AA failure (do not raise as a defect); log as a UX advisory only.", "minor"));
      }
    }
    if (!noHover.length) return [];
    return [{
      id: "eu-link-no-hover-feedback",
      impact: "minor",
      tags: ["best-practice", "EU-visual", "review"],
      description: "Links with no hover feedback at all — advisory, not a WCAG AA defect. [UX advisory — see Manual Checklist C-04 note: hover is optional, focus is mandatory]",
      help: "Consider a hover cue (underline or colour+cue) for affordance; ensure the focus state exists regardless",
      helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/focus-visible.html",
      nodes: noHover
    }];
  }

  function run() {
    const rules = [];
    let styleRules = [];
    try { styleRules = allStyleRules(); } catch {}
    try { rules.push(...checkLinksColorOnly(styleRules)); } catch (e) { console.warn("[EU] visual-checks links failed", e); }
    try { rules.push(...checkFocusSuppression(styleRules)); } catch (e) { console.warn("[EU] visual-checks focus failed", e); }
    try { rules.push(...checkNoHoverFeedback(styleRules)); } catch (e) { console.warn("[EU] visual-checks hover failed", e); }
    return rules;
  }

  window.EU_VisualChecks = { run };
})();
