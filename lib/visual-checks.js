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

  // Links inside page chrome (navigation, header, footer, menus, breadcrumbs,
  // pagination, tab strips) are NOT "links in text blocks" — WCAG 1.4.1 /
  // G183 route analysis applies only where a link must be picked out of
  // surrounding prose. Nav-style links are identified by their grouping, so
  // colour-only presentation there is fine and hover-affordance advisories
  // are noise. Every per-link check below skips this scope.
  const NAV_CHROME_SEL = [
    "nav", "[role=navigation]", "header", "[role=banner]",
    "footer", "[role=contentinfo]", "[role=menu]", "[role=menubar]",
    "[role=tablist]", "[aria-label*=breadcrumb i]",
    ".breadcrumb", ".breadcrumbs", ".pagination", ".pager"
  ].join(", ");
  function inNavChrome(el) {
    try { return !!el.closest(NAV_CHROME_SEL); } catch { return false; }
  }

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
      if (inNavChrome(a)) continue; // nav/menu/footer links — 1.4.1 text-block analysis doesn't apply
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
      // Only claim a cue is MISSING when we could actually read some CSS:
      // with every stylesheet cross-origin, styleRules is empty and "not
      // found" would flag every colour-only link on the page.
      if (!styleRules.length) continue;
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
    // Two overfire guards:
    //  • Skip nav/menu/footer chrome — those links are identified by their
    //    grouping and commonly style hover on a parent (li:hover) or via JS;
    //    flagging the whole nav on every page drowned the report.
    //  • If NO :hover rule is readable anywhere (CSS-in-JS, cross-origin
    //    sheets), absence of a match proves nothing — skip entirely rather
    //    than flag every link on the page.
    if (!styleRules.some(r => /:hover/.test(r.selectorText || ""))) return [];
    const anchors = [...document.querySelectorAll("a[href]")]
      .filter(a => a.getClientRects().length && (a.textContent || "").trim() && !inNavChrome(a));
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

  // ── v0.4.7 tranche 2 ────────────────────────────────────────────────────

  // Check 4: form-control / button boundary contrast — 1.4.11 (C-08, C-11).
  // The control must be visually findable: its border OR its fill must reach
  // 3:1 against the adjacent background. Review-tagged (adjacency and
  // essential-exception judgments stay human).
  function checkControlBoundary() {
    const nodes = [];
    const controls = document.querySelectorAll("input:not([type=hidden]), select, textarea, button, [role=button]");
    let seen = 0;
    for (const el of controls) {
      if (seen >= 150 || nodes.length >= MAX_NODES_PER_RULE) break;
      if (!el.getClientRects().length) continue;
      if (el.disabled || el.getAttribute("aria-disabled") === "true") continue;
      seen++;
      const s = getComputedStyle(el);
      const adjacentBg = effectiveBackground(el.parentElement || el);
      let boundary = 0;
      if (s.borderTopStyle !== "none" && parseFloat(s.borderTopWidth) > 0) {
        const bc = composite(parseColor(s.borderTopColor), adjacentBg);
        boundary = Math.max(boundary, contrast(bc, adjacentBg) || 0);
      }
      const fillRaw = parseColor(s.backgroundColor);
      if (fillRaw && fillRaw.a > 0.01) {
        boundary = Math.max(boundary, contrast(composite(fillRaw, adjacentBg), adjacentBg) || 0);
      }
      const isButton = /^(button)$/i.test(el.tagName) || el.getAttribute("role") === "button" || /^(submit|button|reset)$/i.test(el.type || "");
      // Text-only buttons (links styled as actions) are a different pattern; skip
      // when there's neither border nor fill AND it's a button with visible text.
      if (isButton && boundary === 0 && (el.textContent || "").trim()) continue;
      if (boundary > 0 && boundary < 3) {
        nodes.push(nodeFor(el,
          `${isButton ? "Button" : "Form control"} boundary reaches only ${boundary.toFixed(2)}:1 against the adjacent background (needs 3:1 — WCAG 1.4.11). Neither the border nor the fill makes the control findable. Verify manually (adjacent context and essential exceptions are judgment calls).`, "moderate"));
      }
    }
    if (!nodes.length) return [];
    return [{
      id: "eu-control-boundary",
      impact: "moderate",
      tags: ["wcag2aa", "wcag1411", "EU-visual", "review"],
      description: "Form controls / buttons whose border and fill both fall under 3:1 against the adjacent background (WCAG 1.4.11). [Manual Checklist C-08 / C-11]",
      help: "Give the control a border or fill that reaches 3:1 against its surroundings",
      helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html",
      nodes
    }];
  }

  // Check 5: declared focus-ring colours — 1.4.11 (C-09, page-surface pass).
  function checkFocusRingContrast(styleRules) {
    const nodes = [];
    const pageBg = effectiveBackground(document.body || document.documentElement);
    for (const r of styleRules) {
      if (nodes.length >= MAX_NODES_PER_RULE) break;
      const sel = r.selectorText || "";
      if (!/:focus/.test(sel)) continue;
      let ringColor = null, source = "";
      try {
        const oc = r.style.getPropertyValue("outline-color") || (r.style.getPropertyValue("outline").match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i) || [])[0];
        if (oc) { ringColor = parseColor(oc) || cssHexToRgb(oc); source = "outline"; }
        if (!ringColor) {
          const bsc = (r.style.getPropertyValue("box-shadow").match(/rgba?\([^)]+\)|#[0-9a-f]{3,8}/i) || [])[0];
          if (bsc) { ringColor = parseColor(bsc) || cssHexToRgb(bsc); source = "box-shadow"; }
        }
      } catch {}
      if (!ringColor) continue;
      const ratio = contrast(composite(ringColor, pageBg), pageBg);
      if (ratio !== null && ratio < 3) {
        nodes.push({
          html: `<style>${(r.cssText || "").slice(0, 400)}</style>`,
          target: [sel], xpath: [], ancestry: [], impact: "moderate",
          failureSummary: `The ${source} colour declared in this :focus rule reaches only ${ratio.toFixed(2)}:1 against the page background (needs 3:1 — WCAG 1.4.11 applies to the ring itself). Checked against the default page surface only — verify against every surface the control sits on.`,
          any: [], all: [], none: []
        });
      }
    }
    if (!nodes.length) return [];
    return [{
      id: "eu-focus-ring-contrast",
      impact: "moderate",
      tags: ["wcag2aa", "wcag1411", "EU-visual", "review"],
      description: "Declared :focus indicator colours that fall under 3:1 against the page background (WCAG 1.4.11). [Manual Checklist C-09]",
      help: "Focus ring must reach 3:1 against adjacent colours on every surface",
      helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/non-text-contrast.html",
      nodes
    }];
  }
  function cssHexToRgb(hex) {
    const m = /^#([0-9a-f]{3,8})$/i.exec(String(hex || "").trim());
    if (!m) return null;
    let h = m[1];
    if (h.length === 3 || h.length === 4) h = [...h].map(c => c + c).join("");
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: h.length >= 8 ? parseInt(h.slice(6, 8), 16) / 255 : 1 };
  }

  // Check 6: placeholder contrast — 1.4.3 (C-15). ::placeholder is readable
  // via getComputedStyle, so this one is provable.
  function checkPlaceholderContrast() {
    const nodes = [];
    for (const el of document.querySelectorAll("input[placeholder], textarea[placeholder]")) {
      if (nodes.length >= MAX_NODES_PER_RULE) break;
      if (!el.getClientRects().length || !(el.getAttribute("placeholder") || "").trim()) continue;
      let pc = null;
      try { pc = parseColor(getComputedStyle(el, "::placeholder").color); } catch {}
      if (!pc) continue;
      const bg = effectiveBackground(el);
      const ratio = contrast(composite(pc, bg), bg);
      if (ratio !== null && ratio < 4.5) {
        nodes.push(nodeFor(el, `Placeholder text reaches only ${ratio.toFixed(2)}:1 against the field background (needs 4.5:1 — WCAG 1.4.3; placeholder is text).`, "serious"));
      }
    }
    if (!nodes.length) return [];
    return [{
      id: "eu-placeholder-contrast",
      impact: "serious",
      tags: ["wcag2aa", "wcag143", "EU-visual"],
      description: "Placeholder text below 4.5:1 contrast (WCAG 1.4.3). [Manual Checklist C-15]",
      help: "Darken the ::placeholder colour to reach 4.5:1 (and remember placeholders are not labels — see F-01)",
      helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/contrast-minimum.html",
      nodes
    }];
  }

  // Check 7: cheap provable DOM states — F-13, K-04, K-15, S-16.
  function checkDomStates() {
    const rules = [];
    const push = (id, tags, impact, description, help, helpUrl, nodes) => {
      if (nodes.length) rules.push({ id, impact, tags, description, help, helpUrl, nodes });
    };

    // F-13 — aria-invalid=true before the user has typed anything.
    push("eu-aria-invalid-onload", ["wcag2a", "wcag331", "EU-visual", "review"], "moderate",
      "Fields marked aria-invalid=\"true\" at page load — screen readers announce 'invalid' before the user has done anything (WCAG 3.3.1). [Manual Checklist F-13]",
      "Set aria-invalid only after a failed validation", "https://www.w3.org/WAI/WCAG21/Understanding/error-identification.html",
      [...document.querySelectorAll('[aria-invalid="true"]')].slice(0, MAX_NODES_PER_RULE)
        .map(el => nodeFor(el, "aria-invalid=\"true\" is set on initial render, before any user input or submission.", "moderate")));

    // K-04 — positive tabindex hoists elements out of the natural order.
    push("eu-positive-tabindex", ["wcag2a", "wcag243", "EU-visual", "review"], "moderate",
      "Elements with tabindex > 0 — these hoist themselves to the front of the tab order and almost always break visual/focus order parity (WCAG 2.4.3). [Manual Checklist K-04]",
      "Use tabindex=\"0\" and let DOM order drive the tab order", "https://www.w3.org/WAI/WCAG21/Understanding/focus-order.html",
      [...document.querySelectorAll("[tabindex]")].filter(el => parseInt(el.getAttribute("tabindex"), 10) > 0)
        .slice(0, MAX_NODES_PER_RULE)
        .map(el => nodeFor(el, `tabindex="${el.getAttribute("tabindex")}" hoists this element ahead of everything else on the page.`, "moderate")));

    // K-15 — something grabbed focus during load.
    const ae = document.activeElement;
    const focusNodes = [];
    if (ae && ae !== document.body && ae !== document.documentElement) {
      focusNodes.push(nodeFor(ae, "This element holds focus after page load — focus was moved without user action. Verify it doesn't disorient (WCAG 3.2.1). Note: an intentional autofocus on a page whose single purpose is that field (e.g. a search page) may be acceptable.", "minor"));
    }
    for (const el of document.querySelectorAll("[autofocus]")) {
      if (focusNodes.length >= MAX_NODES_PER_RULE) break;
      if (el !== ae) focusNodes.push(nodeFor(el, "autofocus attribute present — focus will be stolen on load.", "minor"));
    }
    push("eu-focus-stolen-onload", ["wcag2a", "wcag321", "EU-visual", "review"], "minor",
      "Focus is moved on page load (autofocus / scripted). Usually disorienting for screen-reader and keyboard users (WCAG 3.2.1). [Manual Checklist K-15]",
      "Let focus start at the top of the document unless the page's single purpose is the focused field",
      "https://www.w3.org/WAI/WCAG21/Understanding/on-focus.html", focusNodes);

    // S-16 — adjacent image link + text link to the same destination.
    const dupNodes = [];
    const anchors = [...document.querySelectorAll("a[href]")];
    for (let i = 0; i < anchors.length - 1 && dupNodes.length < MAX_NODES_PER_RULE; i++) {
      const a = anchors[i], b = anchors[i + 1];
      if (a.href !== b.href) continue;
      const aImgOnly = a.querySelector("img, svg") && !(a.textContent || "").trim();
      const bText = (b.textContent || "").trim();
      if (aImgOnly && bText && a.parentElement && (a.parentElement === b.parentElement || a.parentElement.contains(b) || (b.parentElement && b.parentElement.contains(a)))) {
        dupNodes.push(nodeFor(a, `Image link and the adjacent text link ("${bText.slice(0, 60)}") point at the same destination — screen readers announce it twice. Merge into one link with the image marked decorative.`, "minor"));
      }
    }
    push("eu-duplicate-adjacent-links", ["wcag2a", "wcag244", "EU-visual", "review"], "minor",
      "Adjacent image + text links to the same destination — announced twice in the links list (WCAG 2.4.4 best practice). [Manual Checklist S-16]",
      "Wrap the image and text in a single <a> and give the image empty alt",
      "https://www.w3.org/WAI/WCAG21/Understanding/link-purpose-in-context.html", dupNodes);

    return rules;
  }

  // Check 8: text-spacing survival — 1.4.12 (Z-08). Injects the SC's exact
  // override metrics, reflows, and reports elements that BECOME clipped
  // (already-clipped elements are excluded — that's Z-09's design question).
  function checkTextSpacing() {
    const SAMPLE_SEL = "p, li, dt, dd, a, button, label, h1, h2, h3, h4, h5, h6, td, th, figcaption, summary";
    const clippedNow = () => {
      const out = new Set();
      let n = 0;
      for (const el of document.querySelectorAll(SAMPLE_SEL)) {
        if (++n > 600) break;
        if (!el.getClientRects().length) continue;
        const s = getComputedStyle(el);
        const clipX = /hidden|clip/.test(s.overflowX) && el.scrollWidth > el.clientWidth + 4;
        const clipY = /hidden|clip/.test(s.overflowY) && el.scrollHeight > el.clientHeight + 4;
        if (clipX || clipY) out.add(el);
      }
      return out;
    };
    let style = null;
    try {
      const before = clippedNow();
      style = document.createElement("style");
      style.textContent = "*{line-height:1.5 !important;letter-spacing:0.12em !important;word-spacing:0.16em !important}p{margin-bottom:2em !important}";
      document.documentElement.appendChild(style);
      void document.body.offsetHeight; // force reflow
      const after = clippedNow();
      const nodes = [];
      for (const el of after) {
        if (before.has(el)) continue;
        if (nodes.length >= MAX_NODES_PER_RULE) break;
        nodes.push(nodeFor(el, "This element clips its text when WCAG 1.4.12 text-spacing overrides are applied (line-height 1.5, letter-spacing 0.12em, word-spacing 0.16em, paragraph spacing 2em). Users who need custom spacing lose content here.", "moderate"));
      }
      if (!nodes.length) return [];
      return [{
        id: "eu-text-spacing-clipped",
        impact: "moderate",
        tags: ["wcag2aa", "wcag1412", "EU-visual", "review"],
        description: "Elements that clip their text under the WCAG 1.4.12 spacing overrides. [Manual Checklist Z-08]",
        help: "Avoid fixed heights on text containers; let them grow with the text",
        helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/text-spacing.html",
        nodes
      }];
    } catch { return []; }
    finally {
      try { style && style.remove(); } catch {}
    }
  }

  // Check 9 (async): moving content — 2.2.2 (M-01/M-02/M-05) + reduced-motion
  // (M-06). Samples candidate regions for 2.5 s; only pays that cost when
  // candidates exist.
  const MOTION_SEL = "[class*=carousel i], [class*=slider i], [class*=swiper i], [class*=marquee i], [class*=ticker i], [data-ride], [class*=slideshow i]";
  async function checkMotion(styleRules) {
    let candidates = [];
    try { candidates = [...document.querySelectorAll(MOTION_SEL)].filter(el => el.getClientRects().length).slice(0, 10); } catch {}
    if (!candidates.length) return [];
    const snap = (el) => {
      try {
        const first = el.firstElementChild;
        const r = first ? first.getBoundingClientRect() : el.getBoundingClientRect();
        const t = first ? getComputedStyle(first).transform : "";
        return `${Math.round(r.left)},${Math.round(r.top)}|${t}|${(el.innerHTML || "").length}`;
      } catch { return ""; }
    };
    const before = candidates.map(snap);
    await new Promise(r => setTimeout(r, 2500));
    const moving = candidates.filter((el, i) => snap(el) !== before[i]);
    if (!moving.length) return [];

    const rules = [];
    const noPause = moving.filter(el => {
      const controls = [...el.querySelectorAll("button, [role=button], a, input[type=button]")];
      return !controls.some(c => /pause|stop|play/i.test(`${c.textContent} ${c.getAttribute("aria-label") || ""} ${c.title || ""}`));
    }).slice(0, MAX_NODES_PER_RULE);
    if (noPause.length) {
      rules.push({
        id: "eu-motion-no-pause",
        impact: "serious",
        tags: ["wcag2a", "wcag222", "EU-visual", "review"],
        description: "Auto-moving content (carousel/slider/ticker) with no pause/stop control found inside it (WCAG 2.2.2 — motion over 5s must be pausable). [Manual Checklist M-01 / M-02 / M-05]",
        help: "Add a visible, keyboard-reachable pause control; also verify rotation stops on hover and focus (M-03)",
        helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/pause-stop-hide.html",
        nodes: noPause.map(el => nodeFor(el, "This region changed continuously during a 2.5s observation window and contains no control matching pause/stop/play. Confirm: does the motion continue past 5 seconds, and is there truly no way to stop it?", "serious"))
      });
    }
    // M-06 — moving content + no prefers-reduced-motion anywhere in the CSS.
    let hasReducedMotion = false;
    try {
      for (const sheet of document.styleSheets) {
        let rulesList = null;
        try { rulesList = sheet.cssRules; } catch { continue; }
        if (!rulesList) continue;
        for (const r of rulesList) {
          if (r.media && /prefers-reduced-motion/.test(r.media.mediaText || "")) { hasReducedMotion = true; break; }
          if (r.conditionText && /prefers-reduced-motion/.test(r.conditionText)) { hasReducedMotion = true; break; }
        }
        if (hasReducedMotion) break;
      }
    } catch {}
    if (!hasReducedMotion) {
      rules.push({
        id: "eu-no-reduced-motion",
        impact: "minor",
        tags: ["best-practice", "wcag222", "EU-visual", "review"],
        description: "Page has auto-moving content but its CSS contains no prefers-reduced-motion media query (WCAG 2.2.2 adjacent / motion-sensitivity best practice). [Manual Checklist M-06]",
        help: "Honour prefers-reduced-motion: disable auto-rotation and large animations when set",
        helpUrl: "https://www.w3.org/WAI/WCAG21/Understanding/pause-stop-hide.html",
        nodes: [nodeFor(moving[0], "Moving content detected while no prefers-reduced-motion rule exists in any accessible stylesheet.", "minor")]
      });
    }
    return rules;
  }

  async function run() {
    const rules = [];
    let styleRules = [];
    try { styleRules = allStyleRules(); } catch {}
    try { rules.push(...checkLinksColorOnly(styleRules)); } catch (e) { console.warn("[EU] visual-checks links failed", e); }
    try { rules.push(...checkFocusSuppression(styleRules)); } catch (e) { console.warn("[EU] visual-checks focus failed", e); }
    try { rules.push(...checkNoHoverFeedback(styleRules)); } catch (e) { console.warn("[EU] visual-checks hover failed", e); }
    try { rules.push(...checkControlBoundary()); } catch (e) { console.warn("[EU] visual-checks controls failed", e); }
    try { rules.push(...checkFocusRingContrast(styleRules)); } catch (e) { console.warn("[EU] visual-checks focus-ring failed", e); }
    try { rules.push(...checkPlaceholderContrast()); } catch (e) { console.warn("[EU] visual-checks placeholder failed", e); }
    try { rules.push(...checkDomStates()); } catch (e) { console.warn("[EU] visual-checks dom-states failed", e); }
    try { rules.push(...checkTextSpacing()); } catch (e) { console.warn("[EU] visual-checks text-spacing failed", e); }
    try { rules.push(...await checkMotion(styleRules)); } catch (e) { console.warn("[EU] visual-checks motion failed", e); }
    return rules;
  }

  window.EU_VisualChecks = { run };
})();
