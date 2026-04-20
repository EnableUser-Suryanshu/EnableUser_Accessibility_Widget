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
      template: await computeTemplateSignals()
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
      headings: document.querySelectorAll("h1,h2,h3,h4,h5,h6").length,
      sections: document.querySelectorAll("section,article,nav,main,aside,footer").length,
      forms: document.querySelectorAll("form").length,
      ariaRoles: document.querySelectorAll("[role]").length,
      links: document.querySelectorAll("a[href]").length,
      images: document.querySelectorAll("img").length,
      buttons: document.querySelectorAll("button").length,
      inputs: document.querySelectorAll("input,select,textarea").length
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
function extractSignature(root) {
  const sig = [];

  const landmarkTags = [
    "header", "nav", "main", "article", "aside", "footer",
    "section", "form", "dialog", "details", "summary", "figure", "figcaption",
    "table", "thead", "tbody", "tfoot",
    "h1", "h2", "h3", "h4", "h5", "h6"
  ];
  for (const tag of landmarkTags) {
    for (const el of root.querySelectorAll(tag)) {
      sig.push(`${el.tagName.toLowerCase()}:${el.getAttribute("role") || ""}:${firstClasses(el, 3)}`);
    }
  }

  for (const el of root.querySelectorAll("[role]")) {
    sig.push(`${el.tagName.toLowerCase()}:${el.getAttribute("role") || ""}:${firstClasses(el, 3)}`);
  }

  const hCounts = [1, 2, 3, 4, 5, 6].map(n => root.querySelectorAll(`h${n}`).length);
  sig.push("H:" + hCounts.join("-"));

  const LAYOUT_PATTERNS = [
    "layout", "template", "container", "wrapper", "grid", "flex", "row", "col-",
    "block", "module", "widget", "component", "page-", "content"
  ];
  const seen = new Set();
  for (const pattern of LAYOUT_PATTERNS) {
    for (const el of root.querySelectorAll(`[class*="${pattern}" i]`)) {
      const key = `${el.tagName.toLowerCase()}::${firstClasses(el, 3)}`;
      if (seen.has(key)) continue;
      seen.add(key);
      sig.push(key);
    }
  }

  return sig;
}

function firstClasses(el, n) {
  const raw = (el.className || "").toString().trim();
  if (!raw) return "";
  const parts = raw.split(/\s+/).filter(c => c.length > 1 && !/\d{4,}/.test(c)).slice(0, n);
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
    "blog", "news", "articles", "article", "post", "posts", "newsletter", "research", "reports",
    "resources", "insights", "case-studies", "stories", "learn", "docs", "help", "support",
    "shop", "products", "store", "collections", "category", "authors", "author", "tags", "tag",
    "topics", "events", "webinars", "podcast", "videos", "about", "team", "careers", "contact", "legal", "privacy"
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
    return hex.slice(0, 8);
  } catch {
    return "";
  }
}
