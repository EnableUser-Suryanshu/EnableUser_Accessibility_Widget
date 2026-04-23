// Content script: runs axe-core on the page and emits a FULL payload —
// every field axe reports, for every node, for every rule category
// (violations, passes, incomplete, inapplicable). No truncation anywhere.
// Also computes a SiteScope-style DOM fingerprint + URL cluster + text hash
// so the background can cluster pages into templates in the report.

(async () => {
  try {
    if (typeof window.axe === "undefined") throw new Error("axe-core not loaded");

    if (document.readyState !== "complete") {
      await new Promise(r => window.addEventListener("load", r, { once: true }));
    }

    const started = performance.now();
    const startedAt = new Date().toISOString();

    // Run with ALL result types enabled so we can surface the complete picture,
    // not just violations. runOnly keeps us scoped to WCAG 2.1 A/AA tags.
    const res = await window.axe.run(document, {
      runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
      resultTypes: ["violations", "passes", "incomplete", "inapplicable"]
    });
    const durationMs = Math.round(performance.now() - started);

    // Run our custom India / GIGW / Media checks and merge them into the
    // violation stream. They produce axe-shaped rule objects so the rest of
    // the pipeline doesn't need to know they came from a different source.
    const customRules = [];
    try {
      if (window.EU_IndiaChecks?.run) customRules.push(...window.EU_IndiaChecks.run(document));
    } catch (e) { console.warn("[EU] india-checks failed", e); }
    try {
      if (window.EU_GIGWChecks?.run) customRules.push(...window.EU_GIGWChecks.run(document));
    } catch (e) { console.warn("[EU] gigw-checks failed", e); }
    // Media checks run collect() so the same pass populates both the rules
    // stream AND the media inventory attached to the payload below.
    let mediaInventory = { videos: [], audios: [], iframeVideos: [], documents: [] };
    try {
      if (window.EU_MediaChecks?.collect) {
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
      if (window.EU_Is17802Checks?.collect) {
        const r = window.EU_Is17802Checks.collect();
        customRules.push(...(r.rules || []));
        is17802Site = r.site || null;
      }
    } catch (e) { console.warn("[EU] is17802-checks failed", e); }
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
      template: await computeTemplateSignals(),
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
  }
})();

// ─────────────────────────────────────────────────────────────────────────────
// Node normalisation — preserves every axe field without any length limits.
// ─────────────────────────────────────────────────────────────────────────────

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

    return {
      fingerprint,                           // 8-hex structural hash — template id
      textHash,                              // 8-hex content hash — exact-content dedup signal
      urlCluster: clusterUrl(location.href), // path-shape bucket (/blog [index], /services/[detail], ...)
      signatureItems: sigItems.length,
      elementCounts,
      textLength: text.length
    };
  } catch (err) {
    return { fingerprint: "error", textHash: "error", urlCluster: "unknown", error: String(err?.message || err) };
  }
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

  // Bucket a count into {0, 1, few=2-5, many=6-20, mass=21+}
  const bucket = n =>
    n === 0 ? "0" :
    n === 1 ? "1" :
    n <= 5 ? "few" :
    n <= 20 ? "many" : "mass";
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
  for (const tag of landmarkTags) {
    for (const el of qsaDeep(tag, root)) {
      const d = depthBucket(depthOf(el) - baseDepth);
      const kids = bucket(el.children?.length || 0);
      sig.push(`${el.tagName.toLowerCase()}:${el.getAttribute("role") || ""}:${firstClasses(el, 3)}:d=${d}:k=${kids}`);
    }
  }

  for (const el of qsaDeep("[role]", root)) {
    const d = depthBucket(depthOf(el) - baseDepth);
    sig.push(`${el.tagName.toLowerCase()}:${el.getAttribute("role") || ""}:${firstClasses(el, 3)}:d=${d}`);
  }

  const hCounts = [1, 2, 3, 4, 5, 6].map(n => qsaDeep(`h${n}`, root).length);
  sig.push("H:" + hCounts.join("-"));

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
