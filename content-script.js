// Content script: runs axe-core on the page and emits a FULL payload —
// every field axe reports, for every node, for every rule category
// (violations, passes, incomplete, inapplicable). No truncation anywhere.
// Also computes a SiteScope-style DOM fingerprint + URL cluster + text hash
// so the background can cluster pages into templates in the report.

async function __euScan() {
  window.__euScanRunning = true;
  try {
    // Operator's scan options (tag set, per-check toggles, overlay dismissal)
    // handed in by background.js via window.__EU_SCAN_OPTS in this ISOLATED world.
    const scanOpts = (typeof window !== "undefined" && window.__EU_SCAN_OPTS) || {};
    const checks = scanOpts.checks || {};
    const runAxeWanted = checks.axe !== false; // default ON
    if (runAxeWanted && typeof window.axe === "undefined") throw new Error("axe-core not loaded");

    if (document.readyState !== "complete") {
      await new Promise(r => window.addEventListener("load", r, { once: true }));
    }

    // v0.4.0 team-merge — MutationObserver quiet-wait.
    // Wait for the DOM to stop mutating before snapshotting structural
    // signals (axe AND our template fingerprint). On SPAs/hydrating pages
    // the page is "loaded" well before React/Vue/Angular has finished
    // swapping the initial server HTML for client-rendered content; axe
    // run against the pre-hydration tree misses actionable issues (bad
    // ARIA on async-inserted widgets, focus traps in lazy-rendered
    // modals, contrast on client-painted text), and our DOM simhash is
    // wrong because half the page hasn't mounted yet. Cap at 10s so a
    // page that keeps twitching (ads, carousels) can't stall the scan.
    await new Promise(resolve => {
      const MAX_MS = 10000;
      const QUIET_MS = 1000;
      const startMs = Date.now();
      let lastMutation = startMs;
      let obs;
      try {
        obs = new MutationObserver(() => { lastMutation = Date.now(); });
        obs.observe(document, { subtree: true, childList: true });
      } catch { resolve(); return; }
      const finish = () => { try { obs.disconnect(); } catch {} resolve(); };
      (function tick() {
        const now = Date.now();
        if (now - startMs >= MAX_MS) return finish();
        if (now - lastMutation >= QUIET_MS) return finish();
        setTimeout(tick, 150);
      })();
    });
    const started = performance.now();
    const startedAt = new Date().toISOString();

    // Run with ALL result types enabled so we can surface the complete picture,
    // not just violations. runOnly keeps us scoped to WCAG 2.1 A/AA tags.
    //
    // preload:false — axe-core by default preloads CSSOM by fetch()ing every
    // linked stylesheet. On pages with cross-origin or CSP-blocked stylesheets
    // (embeds like YouTube/Twitter/analytics/fonts) those fetches fail with a
    // ProgressEvent and axe surfaces "Couldn't load preload assets:
    // [object ProgressEvent]". Disabling preload skips that fetch; color-contrast
    // still evaluates against same-origin + inline styles, which is where
    // actionable contrast issues live anyway.
    //
    // Outer retry — belt-and-braces for the rare case where a navigation race
    // or DOM mutation throws mid-rule-execution.
    // Tag set is chosen by the operator's WCAG version selection and handed in
    // by background.js via window.__EU_SCAN_OPTS (set in the same ISOLATED
    // world immediately before this script is injected). Falls back to WCAG
    // 2.1 A+AA if nothing was provided.
    const axeTags = Array.isArray(scanOpts.axeTags) && scanOpts.axeTags.length
      ? scanOpts.axeTags
      : ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
    // xpath:true + ancestry:true — axe omits both by default (they come back
    // "" / [":root"]). Enabling them populates the XPath and Ancestry columns
    // that the report, CSV, and XLSX already expose but were always blank.
    const runAxe = () => window.axe.run(document, {
      runOnly: { type: "tag", values: axeTags },
      resultTypes: ["violations", "passes", "incomplete", "inapplicable"],
      preload: false,
      xpath: true,
      ancestry: true
    });
    // Run axe. Three cases:
    //  • dismissOverlays + auditBoth → audit TWICE: once with the overlay
    //    present (captures the banner/modal's OWN issues) and once after
    //    dismissing it (the real page), then merge (dedupe nodes by selector+HTML).
    //  • dismissOverlays only → dismiss, then audit the real page once.
    //  • neither → audit once as loaded.
    // axe is also optional: with it off we emit an empty result and let the
    // custom rules below populate the payload.
    let res, lastAxeErr;
    const runAxeRetry = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        try { return await runAxe(); }
        catch (e) {
          lastAxeErr = e;
          if (attempt === 2) throw lastAxeErr;
          await new Promise(r => setTimeout(r, 250 * (attempt + 1)));
        }
      }
    };
    if (runAxeWanted) {
      if (scanOpts.dismissOverlays && scanOpts.auditBoth) {
        // Two passes ONLY when an overlay is actually present. Pass 1 (overlay
        // up) captures the banner/modal's own issues; we dismiss; if something
        // was dismissed we run pass 2 on the real page and merge. If nothing
        // was dismissed (no modal on this page) the second pass would be
        // identical, so we skip it — no wasted double-run on plain pages.
        const before = await runAxeRetry();
        let dismissed = 0;
        try { dismissed = await dismissBlockingOverlays(); } catch (e) { console.warn("[EU] overlay dismissal failed", e); }
        if (dismissed > 0) {
          const after = await runAxeRetry();
          res = euMergeAxeResults(before, after);
        } else {
          res = before;
        }
      } else {
        if (scanOpts.dismissOverlays) {
          try { await dismissBlockingOverlays(); } catch (e) { console.warn("[EU] overlay dismissal failed", e); }
        }
        res = await runAxeRetry();
      }
    } else {
      if (scanOpts.dismissOverlays) {
        try { await dismissBlockingOverlays(); } catch (e) { console.warn("[EU] overlay dismissal failed", e); }
      }
      res = { violations: [], passes: [], incomplete: [], inapplicable: [], testEngine: null, testRunner: null, testEnvironment: null, toolOptions: null, timestamp: null, url: location.href };
    }
    const durationMs = Math.round(performance.now() - started);

    // Run our custom India / Media / IS 17802 checks and merge them into the
    // violation stream. They produce axe-shaped rule objects so the rest of
    // the pipeline doesn't need to know they came from a different source.
    const customRules = [];
    try {
      if (checks.india !== false && window.EU_IndiaChecks?.run) customRules.push(...window.EU_IndiaChecks.run(document));
    } catch (e) { console.warn("[EU] india-checks failed", e); }
    // Media checks run collect() so the same pass populates both the rules
    // stream AND the media inventory attached to the payload below.
    let mediaInventory = { videos: [], audios: [], iframeVideos: [], documents: [] };
    try {
      if (checks.media !== false && window.EU_MediaChecks?.collect) {
        const mediaResult = window.EU_MediaChecks.collect();
        customRules.push(...(mediaResult.rules || []));
        mediaInventory = mediaResult.inventory || mediaInventory;
      }
    } catch (e) { console.warn("[EU] media-checks failed", e); }
    // IS 17802 site-governance checks (Ch 10 / Ch 12 / Ch 13). Like
    // media-checks, collect() returns both rules and a structured `site`
    // snapshot we attach to the payload for the report UI to render.
    let is17802Site = null;
    try {
      if (checks.is17802 !== false && window.EU_Is17802Checks?.collect) {
        const r = window.EU_Is17802Checks.collect();
        customRules.push(...(r.rules || []));
        is17802Site = r.site || null;
      }
    } catch (e) { console.warn("[EU] is17802-checks failed", e); }
    // v0.4.6 — visual-state checks (colour-only links, focus suppression,
    // hover cues). v0.4.7 adds control-boundary/focus-ring/placeholder
    // contrast, DOM-state checks, text-spacing survival, and an async 2.5s
    // motion-sampling pass (only paid when carousel-like candidates exist).
    // Provable failures merge as violations; judgment-dependent findings
    // carry the "review" tag and land in incomplete.
    try {
      if (checks.visual === true && window.EU_VisualChecks?.run) customRules.push(...(await window.EU_VisualChecks.run()));
    } catch (e) { console.warn("[EU] visual-checks failed", e); }
    // Split custom rules by impact + review tag — "review"-tagged rules go
    // to incomplete (auditor needs to confirm), others to violations. The
    // tag-based split replaces the old impact-based one so serious/moderate
    // review items (e.g. audio transcript, video AD) land in incomplete
    // rather than violations.
    const customViolations = customRules.filter(r => !(r.tags || []).includes("review"));
    const customIncomplete = customRules.filter(r => (r.tags || []).includes("review"));
    res.violations = [...(res.violations || []), ...customViolations];
    res.incomplete = [...(res.incomplete || []), ...customIncomplete];

    // Normalise a result category (violations|passes|incomplete|inapplicable)
    // into a flat rule array with every node + every check preserved.
    const normRules = (rules) => (rules || []).map(r => ({
      ruleId: r.id,
      impact: r.impact || null,
      tags: r.tags || [],
      description: r.description || "",
      help: r.help || "",
      helpUrl: r.helpUrl || "",
      nodes: (r.nodes || []).map(n => normNode(n))
    }));

    const payload = {
      title: document.title,
      pageUrl: location.href,
      scanStartedAt: startedAt,
      scanDurationMs: durationMs,
      // Axe-level metadata — captured verbatim so the report can show which
      // engine/environment produced the numbers.
      testEngine: res.testEngine || null,
      testRunner: res.testRunner || null,
      testEnvironment: res.testEnvironment || null,
      toolOptions: res.toolOptions || null,
      axeTimestamp: res.timestamp || null,
      axeUrl: res.url || location.href,
      // All four result types, full fidelity.
      violations: normRules(res.violations),
      passes: normRules(res.passes),
      incomplete: normRules(res.incomplete),
      inapplicable: normRules(res.inapplicable),
      template: (await computeTemplateSignals()),
      // Flat inventory of every video / audio / embedded player / document
      // link found on this page. Feeds the report's Media & Documents section.
      mediaInventory,
      // IS 17802 site-governance snapshot — present whenever the page
      // matched an accessibility-statement URL/title, plus feedback-channel
      // counts on every page. null if the check module didn't run.
      is17802Site
    };
    chrome.runtime.sendMessage({ type: "SCAN_RESULT", payload });
  } catch (err) {
    chrome.runtime.sendMessage({
      type: "SCAN_ERROR",
      payload: { reason: String(err?.message || err), stack: err?.stack || "" }
    });
  } finally {
    window.__euScanRunning = false;
  }
}

// Re-scan support. Chrome silently no-ops a second
// chrome.scripting.executeScript({files:[...]}) of the same file into the
// same document + world — verified empirically (Chrome 152): the call
// resolves in 0 ms and the script body never executes. So the FIRST
// injection wires a persistent EU_RESCAN listener and runs the scan; every
// later scan of this document is triggered by message instead of
// re-injection (see runContentScan). The latch stops overlapping runs —
// axe.run throws if started while a run is in flight.
(() => {
  if (!window.__euScanWired) {
    window.__euScanWired = true;
    chrome.runtime.onMessage.addListener((msg) => {
      if (msg && msg.type === "EU_RESCAN" && !window.__euScanRunning) __euScan();
    });
  }
  __euScan();
})();

// ─────────────────────────────────────────────────────────────────────────────
// Node normalisation — preserves every axe field without any length limits.
// ─────────────────────────────────────────────────────────────────────────────

// ─────────────────────────────────────────────────────────────────────────────
// v0.4.4 — Blocking-overlay dismissal. Handles cookie/consent banners (OneTrust,
// Cookiebot, Didomi, Quantcast, Osano, CookieYes, …), SEBI-style announcement
// interstitials, newsletter/subscribe popups, age gates, and custom <div>
// overlays — not just <dialog>. Precise by design so it never disturbs real
// page content:
//   1. Click known CMP accept/close controls (high confidence).
//   2. Click accept/close/dismiss buttons ONLY when they sit inside an
//      overlay-like container (role=dialog/alertdialog, aria-modal, a high
//      z-index fixed/sticky ancestor, or a class/id naming a modal/popup/
//      consent/overlay/announcement/etc.).
//   3. Last resort: hide full-viewport fixed/sticky high-z-index overlays and
//      release the scroll lock modals leave on <html>/<body>.
// Runs a few passes because sites stack gates (cookie → newsletter → notice).
// v0.4.8 — all click/hide passes now pierce open shadow roots (Usercentrics-
// style CMPs render entirely inside one), and the accept/close text matcher
// understands Hindi labels for Indian-language sites.
// ─────────────────────────────────────────────────────────────────────────────
const OVERLAY_HINT_RE = /(modal|popup|pop-up|overlay|consent|cookie|gdpr|ccpa|cmp|interstitial|backdrop|lightbox|dialog|notice|banner|announce|disclaimer|subscribe|newsletter|age-?gate|paywall|drawer)/i;
const ACCEPT_TEXT_RE = /^(accept(\s+all)?(\s+cookies)?|i\s+accept|agree|i\s+agree|allow(\s+all)?|ok(ay)?|got\s+it!?|understood|i\s+understand|continue|proceed|close|dismiss|no,?\s*thanks|skip|maybe\s+later|not\s+now|✕|×|✖|x|(सभी\s+)?स्वीकार(\s+करें)?|स्वीकारें|सहमति\s+दें|(मैं\s+)?सहमत(\s+हूँ|\s+हूं)?|ठीक\s+है|समझ\s+(गया|गई)|बंद\s+करें|जारी\s+रखें|आगे\s+बढ़ें|अभी\s+नहीं|बाद\s+में)$/i;
const EU_CMP_SELECTORS = [
  "#onetrust-accept-btn-handler", ".onetrust-close-btn-handler", "#accept-recommended-btn-handler",
  "#CybotCookiebotDialogBodyLevelButtonLevelOptinAllowAll", "#CybotCookiebotDialogBodyButtonAccept",
  "#didomi-notice-agree-button", ".qc-cmp2-summary-buttons button[mode='primary']",
  ".osano-cm-accept-all", ".cky-btn-accept", "#hs-eu-confirmation-button",
  ".cc-allow", ".cc-dismiss", ".cookie-accept", ".accept-cookies", "#accept-cookies",
  "button[data-cookiebanner='accept_button']",
  // Usercentrics (lives in an open shadow root under #usercentrics-root).
  "button[data-testid='uc-accept-all-button']",
  // Google Funding Choices (very common on ad-funded news sites).
  ".fc-cta-consent", "button.fc-cta-consent"
];

function euOverlayVisible(el) {
  if (!el) return false;
  let cs; try { cs = getComputedStyle(el); } catch { return false; }
  if (cs.display === "none" || cs.visibility === "hidden" || parseFloat(cs.opacity || "1") === 0) return false;
  return el.offsetParent !== null || cs.position === "fixed" || cs.position === "sticky";
}
function euInOverlay(el) {
  let cur = el, depth = 0;
  while (cur && depth < 12) {
    if (cur.getAttribute) {
      const role = cur.getAttribute("role");
      if (role === "dialog" || role === "alertdialog") return true;
      if (cur.getAttribute("aria-modal") === "true") return true;
      const idc = `${cur.id || ""} ${typeof cur.className === "string" ? cur.className : ""}`.trim();
      if (idc && OVERLAY_HINT_RE.test(idc)) return true;
      let cs; try { cs = getComputedStyle(cur); } catch { cs = null; }
      if (cs && (cs.position === "fixed" || cs.position === "sticky") && (parseInt(cs.zIndex, 10) || 0) >= 1000) return true;
    }
    // Cross open-shadow boundaries: at a shadow root's top, hop to the host so
    // overlay hints on the host element (e.g. #usercentrics-root) still count.
    let next = cur.parentElement;
    if (!next) { try { const rn = cur.getRootNode(); next = rn && rn.host ? rn.host : null; } catch { next = null; } }
    cur = next;
    depth++;
  }
  return false;
}
function euClick(el) { try { el.click(); return true; } catch { return false; } }

// One bounded walk collecting document + every reachable open shadow root, so
// each dismissal pass queries every root once instead of re-walking the tree
// per selector. Closed shadow roots stay opaque (spec). Own literal cap — do
// NOT use TMPL_WALK_CAP here; its `const` may still be in TDZ when the first
// dismissal pass runs during initial script evaluation.
function euAllRoots() {
  const roots = [document];
  let visited = 0;
  (function walk(node) {
    if (!node || visited > 30000) return;
    let all = []; try { all = node.querySelectorAll("*"); } catch { return; }
    for (const el of all) {
      if (++visited > 30000) return;
      if (el.shadowRoot) { roots.push(el.shadowRoot); walk(el.shadowRoot); }
    }
  })(document);
  return roots;
}

function euClickDismissers() {
  let clicked = 0;
  const roots = euAllRoots();
  // Iterate rather than spread — see euHideBlockingOverlays. Spreading a NodeList
  // into push() makes every node an argument, which throws RangeError past ~65k.
  // Lower risk here than there (these selectors are specific, not "*"), but the
  // broad-selector pass below queries "button, [role=button], a, …" which a large
  // page can absolutely exceed.
  const qAll = (sel) => {
    const out = [];
    for (const root of roots) {
      try {
        const found = root.querySelectorAll(sel);
        for (let i = 0; i < found.length; i++) out.push(found[i]);
      } catch {}
    }
    return out;
  };
  for (const sel of EU_CMP_SELECTORS) {
    for (const el of qAll(sel)) {
      if (euOverlayVisible(el) && euClick(el)) { clicked++; break; }
    }
  }
  const nodes = qAll("button, [role='button'], a, input[type='button'], input[type='submit'], [data-dismiss], .close, [aria-label]");
  let scanned = 0;
  for (const el of nodes) {
    if (scanned++ > 4000) break;
    const aria = (el.getAttribute && el.getAttribute("aria-label")) || "";
    const label = (aria || el.textContent || el.value || "").trim();
    if (!label || label.length > 28) continue;
    if (!ACCEPT_TEXT_RE.test(label)) continue;
    if (!euOverlayVisible(el)) continue;
    if (!euInOverlay(el)) continue; // precision: only act inside overlay-like containers
    if (euClick(el)) clicked++;
  }
  return clicked;
}

function euHideBlockingOverlays() {
  let hidden = 0;
  const vw = window.innerWidth, vh = window.innerHeight;
  const nodes = [];
  // Collect per root, iterating rather than spreading.
  //
  // `nodes.push(...nodeList)` passes every node as a separate argument, so a
  // document with more than ~65k elements threw RangeError (Maximum call stack
  // size exceeded). One shared try/catch around the whole loop meant that
  // exception abandoned the entire collection — `nodes` came back empty and
  // overlay dismissal silently did nothing, on exactly the large pages most
  // likely to carry a consent wall. axe then audited the page with the overlay
  // still covering it.
  //
  // Per-root try/catch so one unreadable shadow root cannot cost the others.
  for (const root of euAllRoots()) {
    try {
      const found = root.querySelectorAll(root === document ? "body *" : "*");
      for (let i = 0; i < found.length; i++) nodes.push(found[i]);
    } catch (err) {
      console.warn("[EU] overlay scan skipped a root:", err?.message || err);
    }
  }
  let scanned = 0;
  for (const el of nodes) {
    // getComputedStyle per element is the expensive part, so this bounds work
    // rather than findings. It does affect results though — giving up early can
    // leave a consent overlay in place for the audit — so say so.
    if (scanned++ > 8000) {
      console.warn(`[EU] overlay scan stopped after 8000 of ${nodes.length} elements — an overlay below that point would not have been dismissed`);
      break;
    }
    let cs; try { cs = getComputedStyle(el); } catch { continue; }
    if (cs.position !== "fixed" && cs.position !== "sticky") continue;
    if ((parseInt(cs.zIndex, 10) || 0) < 1000) continue;
    let r; try { r = el.getBoundingClientRect(); } catch { continue; }
    if (r.width >= vw * 0.6 && r.height >= vh * 0.6) {
      el.style.setProperty("display", "none", "important");
      hidden++;
    }
  }
  if (hidden) {
    for (const node of [document.documentElement, document.body]) {
      if (!node) continue;
      try {
        node.style.setProperty("overflow", "auto", "important");
        node.classList.remove("modal-open", "no-scroll", "noscroll", "overflow-hidden", "is-locked", "scroll-lock");
      } catch {}
    }
  }
  return hidden;
}

async function dismissBlockingOverlays() {
  let total = 0;
  for (let pass = 0; pass < 3; pass++) {
    const clicked = euClickDismissers();
    total += clicked;
    await new Promise(r => setTimeout(r, 350));
    if (clicked === 0) break;
  }
  total += euHideBlockingOverlays();
  await new Promise(r => setTimeout(r, 200));
  return total; // count of overlays clicked/hidden (0 = nothing was there)
}

// v0.4.4 — merge two axe runs (overlay-present + overlay-dismissed) for the
// "audit both states" mode. Combines rules by id and dedupes nodes by
// selector+HTML so the banner/modal's own issues AND the real page's issues
// both appear without double-counting the nodes common to both passes.
function euMergeRuleArrays(ra, rb) {
  const byId = new Map();
  const addAll = (arr) => {
    for (const rule of (arr || [])) {
      let ex = byId.get(rule.id);
      if (!ex) { ex = Object.assign({}, rule, { nodes: [] }); ex.__seen = new Set(); byId.set(rule.id, ex); }
      for (const n of (rule.nodes || [])) {
        const key = (Array.isArray(n.target) ? n.target.join(" ") : String(n.target || "")) + "|" + (n.html || "");
        if (ex.__seen.has(key)) continue;
        ex.__seen.add(key);
        ex.nodes.push(n);
      }
    }
  };
  addAll(ra); addAll(rb);
  const out = [];
  for (const r of byId.values()) { delete r.__seen; out.push(r); }
  return out;
}
function euMergeAxeResults(a, b) {
  if (!a) return b;
  if (!b) return a;
  return {
    testEngine: a.testEngine || b.testEngine,
    testRunner: a.testRunner || b.testRunner,
    testEnvironment: a.testEnvironment || b.testEnvironment,
    toolOptions: a.toolOptions || b.toolOptions,
    timestamp: a.timestamp || b.timestamp,
    url: a.url || b.url,
    violations: euMergeRuleArrays(a.violations, b.violations),
    passes: euMergeRuleArrays(a.passes, b.passes),
    incomplete: euMergeRuleArrays(a.incomplete, b.incomplete),
    inapplicable: euMergeRuleArrays(a.inapplicable, b.inapplicable)
  };
}

function normNode(n) {
  return {
    // Full HTML snippet — no slice.
    html: n.html || "",
    // Target is always an array of selectors (frame-aware). Keep as array AND
    // also provide the joined form for convenience.
    target: Array.isArray(n.target) ? n.target.slice() : (n.target ? [String(n.target)] : []),
    targetJoined: Array.isArray(n.target) ? n.target.join(" ") : String(n.target || ""),
    ancestry: Array.isArray(n.ancestry) ? n.ancestry.slice() : (n.ancestry ? [String(n.ancestry)] : []),
    xpath: Array.isArray(n.xpath) ? n.xpath.slice() : (n.xpath ? [String(n.xpath)] : []),
    impact: n.impact || null,
    failureSummary: n.failureSummary || "",
    // The three check arrays axe reports per node. Each check has
    // {id, impact, message, data, relatedNodes}. Preserve everything — the
    // `data` field is rule-specific (can be strings, numbers, objects).
    any: (n.any || []).map(normCheck),
    all: (n.all || []).map(normCheck),
    none: (n.none || []).map(normCheck)
  };
}

function normCheck(c) {
  return {
    id: c.id || "",
    impact: c.impact || null,
    message: c.message || "",
    // data can be anything axe wants to pass through — keep as-is (JSON round-trip
    // ensures the structured-clone used by chrome.runtime.sendMessage is happy).
    data: c.data === undefined ? null : safeClone(c.data),
    relatedNodes: (c.relatedNodes || []).map(rn => ({
      target: Array.isArray(rn.target) ? rn.target.slice() : (rn.target ? [String(rn.target)] : []),
      html: rn.html || ""
    }))
  };
}

// Serialise + parse to strip anything non-cloneable (functions, DOM refs etc).
// axe sometimes embeds node refs in `relatedNodes.element` — we only keep the
// serialisable bits. Any field that fails to serialise is dropped silently.
function safeClone(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch { return null; }
}

// ─────────────────────────────────────────────────────────────────────────────
// Template signals: DOM fingerprint, URL cluster, text hash, element counts.
// Self-contained — stays valid even if this file is loaded with minimal env.
// ─────────────────────────────────────────────────────────────────────────────

// Shadow-DOM-aware query. Traverses light DOM + all reachable open shadow
// roots. Closed shadow roots stay opaque (spec). Bounded walk so hostile
// pages can't hang the scanner.
const TMPL_WALK_CAP = 30000;
function qsaDeep(selector, root) {
  const out = [];
  let visited = 0;
  (function walk(node) {
    if (!node || visited > TMPL_WALK_CAP) return;
    if (typeof node.querySelectorAll !== "function") return;
    try { for (const el of node.querySelectorAll(selector)) out.push(el); } catch {}
    const children = node.querySelectorAll("*");
    for (const el of children) {
      visited++;
      if (visited > TMPL_WALK_CAP) return;
      if (el.shadowRoot) walk(el.shadowRoot);
    }
  })(root || document);
  return out;
}

async function computeTemplateSignals() {
  try {
    const sigItems = extractSignature(document);
    const sigStr = sigItems.join("|");
    const fingerprint = await shortHash(sigStr) || "unknown";

    // Full visible text — NO length cap. The report-side logic decides what
    // (if anything) to display; we do not pre-limit information here.
    const text = (document.body?.innerText || "").replace(/\s+/g, " ").trim();
    const textHash = await shortHash(text);

    const elementCounts = {
      headings: qsaDeep("h1,h2,h3,h4,h5,h6").length,
      sections: qsaDeep("section,article,nav,main,aside,footer").length,
      forms: qsaDeep("form").length,
      ariaRoles: qsaDeep("[role]").length,
      links: qsaDeep("a[href]").length,
      images: qsaDeep("img").length,
      buttons: qsaDeep("button").length,
      inputs: qsaDeep("input,select,textarea").length
    };

    // v0.4.0 team-merge — DOM simhash + preview.
    // Orthogonal second dedup/classification signal: a presence-based
    // 64-bit simhash over tag 3-grams along every root-to-leaf path in
    // document.body, with ads and aria-hidden subtrees excluded. Unlike
    // our existing structural fingerprint (which is a SHA-1 of a
    // class/depth/role bucketed signature), the simhash is a Hamming-
    // distance-comparable hash — two templates that differ slightly
    // (e.g. one extra <aside> module) still differ by only a few bits,
    // so the report can cluster near-duplicates with a tolerance slider.
    // Falls to empty string on hostile/empty DOMs; the dedup path treats
    // empty hashes as "unhashed" rather than collapsing them together.
    const { domHash, domPreview } = computeDomSimhash(document);

    return {
      fingerprint,                           // 12-hex structural hash — template id (SiteScope style)
      textHash,                              // 12-hex exact-content hash — content dedup signal
      domHash,                               // 16-hex FNV-64 simhash — near-dup / similarity clustering
      domPreview,                            // Top-level tag path (debug/UI)
      urlCluster: clusterUrl(location.href), // path-shape bucket (/blog [index], /services/[detail], ...)
      signatureItems: sigItems.length,
      elementCounts,
      textLength: text.length
    };
  } catch (err) {
    return { fingerprint: "error", textHash: "error", domHash: "", domPreview: "", urlCluster: "unknown", error: String(err?.message || err) };
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// v0.4.0 team-merge — DOM simhash.
// Port of team crawler-extension's extractLinksInPage simhash path. Walks
// document.body collecting tag 3-grams along every root-to-leaf path as
// presence features (Set, not Bag), hashes each feature with FNV-64, votes
// each bit across features, and emits the sign vector as a 16-hex string.
// Presence-based (not count-weighted) means two pages built from the same
// template but with different numbers of repeated cards/posts hash alike —
// exactly the property we want for template clustering.
// ─────────────────────────────────────────────────────────────────────────────
function computeDomSimhash(doc) {
  const result = { domHash: "", domPreview: "" };
  try {
    const EXCLUDE = new Set(["script", "style", "noscript", "link", "template", "meta", "br", "hr", "head", "title"]);
    const AD_RE = /\b(ad|ads|advert|adsbygoogle|google_ads|banner-ad|banner_ad)\b/i;

    const elIsHidden = el => {
      if (!el || !el.getAttribute) return false;
      if (el.getAttribute("aria-hidden") === "true") return true;
      const s = el.style;
      if (s && (s.display === "none" || s.visibility === "hidden")) return true;
      return false;
    };
    const elIsAd = el => {
      const c = el.className;
      if (!c || typeof c !== "string") return false;
      return AD_RE.test(c);
    };

    const features = new Set();
    const topTags = [];
    const MAX_DEPTH = 10;
    const walk = (el, recent, depth) => {
      if (depth > MAX_DEPTH) return;
      const tag = el.tagName && el.tagName.toLowerCase();
      if (!tag || EXCLUDE.has(tag)) return;
      if (elIsHidden(el) || elIsAd(el)) return;
      const nextRecent = recent.length < 3
        ? recent.concat(tag)
        : [recent[1], recent[2], tag];
      if (nextRecent.length >= 2) features.add(nextRecent.join(">"));
      if (depth <= 2 && topTags.length < 12) topTags.push(tag);
      const kids = el.children;
      for (let i = 0; i < kids.length; i++) walk(kids[i], nextRecent, depth + 1);
    };

    if (doc.body) walk(doc.body, [], 0);

    if (features.size > 0) {
      const MASK = 0xFFFFFFFFFFFFFFFFn;
      const FNV_OFFSET = 0xcbf29ce484222325n;
      const FNV_PRIME = 0x100000001b3n;
      const hash64 = str => {
        let h = FNV_OFFSET;
        for (let i = 0; i < str.length; i++) {
          h ^= BigInt(str.charCodeAt(i));
          h = (h * FNV_PRIME) & MASK;
        }
        return h;
      };
      const bits = new Array(64).fill(0);
      for (const feature of features) {
        const h = hash64(feature);
        for (let i = 0; i < 64; i++) {
          if (((h >> BigInt(i)) & 1n) === 1n) bits[i]++;
          else bits[i]--;
        }
      }
      let out = 0n;
      for (let i = 0; i < 64; i++) {
        if (bits[i] > 0) out |= (1n << BigInt(i));
      }
      result.domHash = out.toString(16).padStart(16, "0");
      result.domPreview = topTags.join(" › ");
    }
  } catch { /* return empty hash on any failure — treated as "unhashed" */ }
  return result;
}

// Collect the same set of signature strings SiteScope's v5.3
// `_fp_bs4_extract_elements` builds — but from the live DOM, not parsed HTML.
// Shadow DOM is traversed so the fingerprint is structurally complete for
// web-component-heavy pages (Lit, Stencil, SFDC Lightning, Polymer).
//
// Feature improvements over the original: (a) relative-depth bucketing on
// each landmark (so listing vs detail pages with same tags but different
// nesting cluster apart), (b) direct-child-count bucketing on containers
// (so a <main> with 3 cards vs 50 cards hashes differently).
function extractSignature(root) {
  const sig = [];
  const baseDepth = depthOf(root);

  // v0.2.8 — Widened buckets. The previous {0, 1, few=2-5, many=6-20,
  // mass=21+} split "few" vs "many" at 5, which meant blog posts with 4
  // h3s clustered separately from posts with 6 h3s even though they
  // shared the same template shell. Real-world article bodies vary from
  // 2 to 20+ headings depending on length; those need to fall into ONE
  // bucket for clustering to be meaningful.
  const bucket = n =>
    n === 0 ? "0" :
    n === 1 ? "1" :
    n <= 20 ? "many" :
    "mass";
  const depthBucket = d =>
    d <= 2 ? "shallow" :
    d <= 5 ? "mid" :
    d <= 9 ? "deep" : "vdeep";

  const landmarkTags = [
    "header", "nav", "main", "article", "aside", "footer",
    "section", "form", "dialog", "details", "summary", "figure", "figcaption",
    "table", "thead", "tbody", "tfoot",
    "h1", "h2", "h3", "h4", "h5", "h6"
  ];
  // v0.2.8 — Aggregate-per-tag rather than per-element. Previously this
  // emitted ONE sig line per landmark element, so a blog post with 8
  // <h3> headings produced 8 lines (each with class + depth + kids
  // count). Two posts with identical shells but different body lengths
  // therefore hashed differently — which is why greysky.capital showed
  // 58 pages / 54 templates when the ~40 blog posts should have
  // collapsed into one template cluster. We now emit: (a) ONE bucketed-
  // count line per landmark tag, (b) ONE structural-signal line for the
  // FIRST occurrence of each tag (classes, depth, kids). This captures
  // the template shell without being held hostage by body content.
  for (const tag of landmarkTags) {
    const els = qsaDeep(tag, root);
    const n = els.length;
    if (n === 0) continue;
    sig.push(`${tag}:n=${bucket(n)}`);
    const el = els[0];
    const d = depthBucket(depthOf(el) - baseDepth);
    const kids = bucket(el.children?.length || 0);
    sig.push(`${tag}[0]:${el.getAttribute("role") || ""}:${firstClasses(el, 3)}:d=${d}:k=${kids}`);
  }

  // v0.2.8 — Same aggregation for [role]-bearing elements. Group by
  // role value, emit count bucket + first-element signal.
  const roleGroups = new Map();
  for (const el of qsaDeep("[role]", root)) {
    const r = el.getAttribute("role") || "";
    if (!roleGroups.has(r)) roleGroups.set(r, []);
    roleGroups.get(r).push(el);
  }
  for (const [role, arr] of roleGroups) {
    sig.push(`role:${role}:n=${bucket(arr.length)}`);
    const el = arr[0];
    const d = depthBucket(depthOf(el) - baseDepth);
    sig.push(`role:${role}[0]:${el.tagName.toLowerCase()}:${firstClasses(el, 3)}:d=${d}`);
  }

  // v0.2.8 — H-count now bucketed instead of exact integer counts.
  // Prior "H:1-5-8-3-0-0" vs "H:1-5-12-4-0-0" caused different hashes
  // for two posts that share the same template but differ in body
  // heading count.
  const hBuckets = [1, 2, 3, 4, 5, 6].map(n => bucket(qsaDeep(`h${n}`, root).length));
  sig.push("H:" + hBuckets.join("-"));

  const LAYOUT_PATTERNS = [
    "layout", "template", "container", "wrapper", "grid", "flex", "row", "col-",
    "block", "module", "widget", "component", "page-", "content"
  ];
  const seen = new Set();
  for (const pattern of LAYOUT_PATTERNS) {
    for (const el of qsaDeep(`[class*="${pattern}" i]`, root)) {
      const kids = bucket(el.children?.length || 0);
      const key = `${el.tagName.toLowerCase()}::${firstClasses(el, 3)}:k=${kids}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sig.push(key);
    }
  }

  return sig;
}

// Depth relative to document root. Traverses across shadow boundaries via
// .host so an element inside a web component still reports its true depth.
function depthOf(node) {
  let d = 0, cur = node;
  while (cur && cur.parentNode) {
    if (cur.parentNode.host) cur = cur.parentNode.host;
    else cur = cur.parentNode;
    d++;
    if (d > 200) break; // safety
  }
  return d;
}

// Class names that jitter between renders but don't indicate a different
// template. We strip them before feeding into the fingerprint so the same
// page rebuilt under a new webpack hash still clusters into the same group.
const CSS_IN_JS_HASH = /^(?:jsx-|css-|sc-|emotion-|mui-|tw-|chakra-|ant-[a-z]+-fadein-|MuiBox-|_[a-zA-Z0-9]+_)[A-Za-z0-9]{4,}$/;
const STATE_PREFIXES = /^(?:is-|has-|active$|open$|closed$|selected$|hover$|focus$|disabled$|aria-[a-z]+-(?:true|false)|js-|-[a-z]+-enter-|-[a-z]+-exit-)/;
const UTILITY_NOISE = /^(?:flex|grid|row|col|mt|mb|mx|my|pt|pb|px|py|px-|py-|mx-|my-|mt-|mb-|ml-|mr-|pl-|pr-|text-|bg-|border-|w-|h-|min-w-|min-h-|max-w-|max-h-|space-|gap-)\d/;

function firstClasses(el, n) {
  const raw = (el.className || "").toString().trim();
  if (!raw) return "";
  const parts = raw.split(/\s+/)
    .filter(c => c.length > 1)
    .filter(c => !/\d{4,}/.test(c))          // reject classes with long digit runs (generated ids)
    .filter(c => !CSS_IN_JS_HASH.test(c))    // reject CSS-in-JS hash classes
    .filter(c => !STATE_PREFIXES.test(c))    // reject interaction-state classes
    .filter(c => !UTILITY_NOISE.test(c))     // reject Tailwind-style utility noise
    .slice(0, n);
  return parts.join(" ");
}

function clusterUrl(href) {
  let u;
  try { u = new URL(href); } catch { return "unknown"; }
  const netloc = u.hostname.toLowerCase();
  if (["click.", "track.", "email.", "link."].some(t => netloc.includes(t))) return "tracking";

  const path = u.pathname.toLowerCase().replace(/^\/+|\/+$/g, "");
  const parts = path.split("/").filter(Boolean);
  if (!parts.length) return "home";

  const HUBS = [
    // English
    "blog", "news", "articles", "article", "post", "posts", "newsletter", "research", "reports",
    "resources", "insights", "case-studies", "stories", "learn", "docs", "help", "support",
    "shop", "products", "store", "collections", "category", "authors", "author", "tags", "tag",
    "topics", "events", "webinars", "podcast", "videos", "about", "team", "careers", "contact", "legal", "privacy",
    // Indian government / NIC common path tokens
    "schemes", "services", "notifications", "tenders", "circulars", "gazettes", "acts",
    "rules", "policy", "policies", "rti", "acts-rules", "press-releases", "downloads", "forms",
    // Hindi (transliterated paths common on .gov.in/.nic.in)
    "samachar", "seva", "sevaen", "yojana", "yojanaen", "niyam", "aadesh", "adhisuchana",
    "suchna", "gathan", "sampark", "vibhag", "mantralaya", "sansthan",
    // Hindi (native Devanagari — .gov.in sites increasingly use these in URLs)
    "समाचार", "सेवा", "सेवाएं", "योजना", "योजनाएं", "नियम", "अधिसूचना", "सूचना",
    "संपर्क", "विभाग", "मंत्रालय", "संस्थान", "सरकारी-योजनाएं"
  ];
  if (HUBS.includes(parts[0])) {
    return parts.length === 1 ? `/${parts[0]} [index]` : `/${parts[0]}/[detail]`;
  }

  const last = parts[parts.length - 1];
  if (/[0-9a-f]{8}-[0-9a-f]{4}/.test(last) || /^\d+$/.test(last) || /\d{4}[/-]\d{2}/.test(path)) {
    return `/${parts[0]}/[dynamic-id]`;
  }
  if (parts.length >= 3) return `/${parts[0]}/${parts[1]}/[detail]`;
  if (parts.length === 2) return `/${parts[0]}/${parts[1]}`;
  return `/${parts[0]}`;
}

async function shortHash(str) {
  if (!str) return "";
  try {
    const bytes = new TextEncoder().encode(str);
    const digest = await crypto.subtle.digest("SHA-1", bytes);
    const hex = [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("");
    // 12 hex = 48 bits. At 10k pages, collision probability is < 1 in 6 million.
    // At 8 hex it was ~1 in 14 per 10k pages — too loose for audit use.
    return hex.slice(0, 12);
  } catch {
    return "";
  }
}
