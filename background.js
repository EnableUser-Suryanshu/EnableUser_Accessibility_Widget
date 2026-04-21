import { toCsv } from "./lib/csv-writer.js";
import { ALL_AA_CRITERIA, extractCriteriaFromTags } from "./lib/wcag-tags.js";
import { standardsFor, PROFILES, PROFILE_KEYS, isInProfile, profileClause } from "./lib/standards.js";
import {
  RequestQueue,
  RateLimiter,
  canonicalize,
  parseRetryAfter,
  retryWithBackoff
} from "./lib/request-queue.js";
import {
  discoverSeedsFromOrigin,
  discoverHreflang,
  probeCommonPaths,
  navSurfacedCollect
} from "./lib/discovery.js";
import { buildScopeDocx } from "./lib/docx-writer.js";
import { buildInventoryXlsx } from "./lib/xlsx-writer.js";

const DEFAULT_MAX_URLS = 50;
const DEFAULT_CRAWL_DEPTH = 1;
const HARD_MAX_URLS = 500;
const HARD_MAX_DEPTH = 5;
const CONCURRENT_TABS = 5;
const TAB_TIMEOUT_MS = 60_000;
const SETTLE_MS = 2_500;

const pending = new Map();
const reports = new Map();
const inventories = new Map(); // inventoryId → { inventory, files: { docx: Blob, xlsx: Blob } }
const rateLimiter = new RateLimiter();

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "SCAN_CURRENT") sendResponse(await scanCurrent(msg.tabId, msg.options));
      else if (msg.type === "SCAN_MULTI") sendResponse(await scanMulti(msg.tabId, msg.options));
      else if (msg.type === "SCAN_INVENTORY") sendResponse(await scanInventory(msg.tabId, msg.options));
      else if (msg.type === "SCAN_RESULT") sendResponse(handleResult(msg.payload, sender));
      else if (msg.type === "SCAN_ERROR") sendResponse(handleError(msg.payload, sender));
      else if (msg.type === "GET_REPORT") sendResponse({ ok: true, report: reports.get(msg.reportId) || null });
      else if (msg.type === "GET_INVENTORY") sendResponse({ ok: true, inventory: inventories.get(msg.inventoryId)?.inventory || null });
      else if (msg.type === "DOWNLOAD_CSV") sendResponse(await downloadCsv(msg.reportId));
      else if (msg.type === "DOWNLOAD_SCOPE_DOCX") sendResponse(await downloadInventoryFile(msg.inventoryId, "docx"));
      else if (msg.type === "DOWNLOAD_INVENTORY_XLSX") sendResponse(await downloadInventoryFile(msg.inventoryId, "xlsx"));
      else sendResponse({ ok: false, error: "unknown message" });
    } catch (err) {
      console.error("[EU]", err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true;
});

chrome.tabs.onRemoved.addListener(tabId => {
  const entry = pending.get(tabId);
  if (entry) {
    clearTimeout(entry.timeoutId);
    pending.delete(tabId);
    entry.reject(new Error("tab closed"));
  }
});

async function scanCurrent(tabId, options) {
  const tab = await chrome.tabs.get(tabId);
  const result = await scanInExistingTab(tabId);
  const profile = (options?.profile && PROFILES[options.profile]) ? options.profile : "wcag21aa";
  const report = buildReport([{ url: tab.url, title: tab.title, ...result }], { mode: "single", seedUrl: tab.url, profile });
  const reportId = `r-${Date.now()}`;
  reports.set(reportId, report);
  await chrome.tabs.create({ url: chrome.runtime.getURL(`report/report.html?id=${reportId}`) });
  return { ok: true, reportId };
}

async function scanMulti(tabId, options) {
  const maxUrls = clamp(parseInt(options?.maxUrls, 10) || DEFAULT_MAX_URLS, 1, HARD_MAX_URLS);
  const crawlDepth = clamp(parseInt(options?.crawlDepth, 10) || DEFAULT_CRAWL_DEPTH, 1, HARD_MAX_DEPTH);
  const profile = (options?.profile && PROFILES[options.profile]) ? options.profile : "wcag21aa";

  const tab = await chrome.tabs.get(tabId);
  const startUrl = tab.url;
  const seedOrigin = safeOrigin(startUrl);

  const queue = new RequestQueue({ scopeUrl: startUrl, maxUrls, maxDepth: crawlDepth, scope: "same-hostname" });
  queue.enqueue(startUrl, { depth: 0, priority: 100, source: "seed" });

  const results = [];
  const depthStats = {};
  const discoveryStats = { nav: 0, body: 0, sitemap: 0, hreflang: 0, commonPaths: 0 };

  queue.next();
  depthStats[0] = 1;
  const startScan = await scanInExistingTab(tabId);
  results.push({ url: startUrl, title: tab.title, depth: 0, source: "seed", ...startScan });

  let sitemapUrls = [], hreflangUrls = [], commonPaths = [];
  if (seedOrigin) {
    [sitemapUrls, hreflangUrls, commonPaths] = await Promise.all([
      discoverSeedsFromOrigin(seedOrigin).catch(() => []),
      discoverHreflang(startUrl).catch(() => []),
      probeCommonPaths(seedOrigin).catch(() => [])
    ]);
  }
  discoveryStats.sitemap = queue.enqueueMany(sitemapUrls, { depth: 1, priority: 3, source: "sitemap" });
  discoveryStats.hreflang = queue.enqueueMany(hreflangUrls, { depth: 1, priority: 5, source: "hreflang" });
  discoveryStats.commonPaths = queue.enqueueMany(commonPaths, { depth: 1, priority: 4, source: "common-path" });

  const seedLinks = await collectNavLinks(tabId);
  const navOnly = seedLinks.filter(l => l.priority >= 10).map(l => l.url);
  const bodyOnly = seedLinks.filter(l => l.priority < 10).map(l => l.url);
  discoveryStats.nav = queue.enqueueMany(navOnly, { depth: 1, priority: 8, source: "nav" });
  discoveryStats.body = queue.enqueueMany(bodyOnly, { depth: 1, priority: 2, source: "body" });

  console.log(`[EU] discovery — nav:${discoveryStats.nav} body:${discoveryStats.body} sitemap:${discoveryStats.sitemap} hreflang:${discoveryStats.hreflang} paths:${discoveryStats.commonPaths} | pending:${queue.pending}`);

  const active = new Set();

  async function launch(req) {
    try {
      await rateLimiter.wait(req.url);
      const r = await scanInNewTab(req.url, req.depth < crawlDepth);
      const { links = [], ...scan } = r;
      rateLimiter.reportSuccess(req.url);
      results.push({ url: req.url, depth: req.depth, source: req.source, ...scan });
      depthStats[req.depth] = (depthStats[req.depth] || 0) + 1;
      if (req.depth < crawlDepth) {
        const nav = links.filter(l => l.priority >= 10).map(l => l.url);
        const body = links.filter(l => l.priority < 10).map(l => l.url);
        queue.enqueueMany(nav, { depth: req.depth + 1, priority: 8, source: "nav" });
        queue.enqueueMany(body, { depth: req.depth + 1, priority: 2, source: "body" });
      }
    } catch (err) {
      const status = err?.status || 0;
      rateLimiter.reportFailure(req.url, { status });
      console.warn(`[EU] scan failed: ${req.url}`, err?.message || err);
      results.push({
        url: req.url, depth: req.depth, source: req.source,
        error: String(err?.message || err),
        violations: [], passes: [], incomplete: [], inapplicable: []
      });
    }
  }

  function pump() {
    while (active.size < CONCURRENT_TABS && queue.pending && queue.remaining > 0) {
      const req = queue.next();
      if (!req) break;
      const p = launch(req).finally(() => { active.delete(p); });
      active.add(p);
    }
  }

  pump();
  while (active.size > 0) {
    await Promise.race(active);
    pump();
  }

  console.log(`[EU] crawl complete — pages per depth:`, depthStats, "rate:", rateLimiter.snapshot());
  const report = buildReport(results, {
    mode: "multi", seedUrl: startUrl, maxUrls, crawlDepth, depthStats, discoveryStats, profile
  });
  const reportId = `r-${Date.now()}`;
  reports.set(reportId, report);
  await chrome.tabs.create({ url: chrome.runtime.getURL(`report/report.html?id=${reportId}`) });
  return { ok: true, reportId };
}

// ─────────────────────────────────────────────────────────────────────────
// Inventory mode — crawl but skip axe. Produces the scope document (.docx)
// + inventory workbook (.xlsx) that a professional audit firm uses before
// committing to the full audit. Same discovery pipeline as scanMulti, but
// each page runs only content-signals.js (no axe-core, much faster).
// ─────────────────────────────────────────────────────────────────────────
async function scanInventory(tabId, options) {
  const maxUrls = clamp(parseInt(options?.maxUrls, 10) || DEFAULT_MAX_URLS, 1, HARD_MAX_URLS);
  const crawlDepth = clamp(parseInt(options?.crawlDepth, 10) || DEFAULT_CRAWL_DEPTH, 1, HARD_MAX_DEPTH);

  const tab = await chrome.tabs.get(tabId);
  const startUrl = tab.url;
  const seedOrigin = safeOrigin(startUrl);
  const seedHost = safeHost(startUrl);

  const queue = new RequestQueue({ scopeUrl: startUrl, maxUrls, maxDepth: crawlDepth, scope: "same-hostname" });
  queue.enqueue(startUrl, { depth: 0, priority: 100, source: "seed" });

  const pages = [];
  const depthStats = {};

  // Seed page runs in the current tab directly.
  queue.next();
  depthStats[0] = 1;
  try {
    const sig = await collectTemplateSignature(tabId);
    const signals = await collectContentSignals(tabId);
    const fingerprint = await sha1Prefix(sig?.sigStr || "", 12);
    pages.push({
      url: startUrl, title: tab.title, depth: 0, source: "seed",
      template_id: fingerprint, url_cluster: sig?.urlCluster || "unknown",
      ...signals
    });
  } catch (err) {
    pages.push({ url: startUrl, depth: 0, source: "seed", error: String(err?.message || err) });
  }

  // Same discovery pipeline as scanMulti.
  let sitemapUrls = [], hreflangUrls = [], commonPaths = [];
  if (seedOrigin) {
    [sitemapUrls, hreflangUrls, commonPaths] = await Promise.all([
      discoverSeedsFromOrigin(seedOrigin).catch(() => []),
      discoverHreflang(startUrl).catch(() => []),
      probeCommonPaths(seedOrigin).catch(() => [])
    ]);
  }
  queue.enqueueMany(sitemapUrls, { depth: 1, priority: 3, source: "sitemap" });
  queue.enqueueMany(hreflangUrls, { depth: 1, priority: 5, source: "hreflang" });
  queue.enqueueMany(commonPaths, { depth: 1, priority: 4, source: "common-path" });

  const seedLinks = await collectNavLinks(tabId);
  const navOnly = seedLinks.filter(l => l.priority >= 10).map(l => l.url);
  const bodyOnly = seedLinks.filter(l => l.priority < 10).map(l => l.url);
  queue.enqueueMany(navOnly, { depth: 1, priority: 8, source: "nav" });
  queue.enqueueMany(bodyOnly, { depth: 1, priority: 2, source: "body" });

  const active = new Set();

  async function launch(req) {
    try {
      await rateLimiter.wait(req.url);
      const result = await inventoryInNewTab(req.url, req.depth < crawlDepth);
      rateLimiter.reportSuccess(req.url);
      const { links = [], ...rest } = result;
      pages.push({
        url: req.url, depth: req.depth, source: req.source, ...rest
      });
      depthStats[req.depth] = (depthStats[req.depth] || 0) + 1;
      if (req.depth < crawlDepth) {
        const nav = links.filter(l => l.priority >= 10).map(l => l.url);
        const body = links.filter(l => l.priority < 10).map(l => l.url);
        queue.enqueueMany(nav, { depth: req.depth + 1, priority: 8, source: "nav" });
        queue.enqueueMany(body, { depth: req.depth + 1, priority: 2, source: "body" });
      }
    } catch (err) {
      rateLimiter.reportFailure(req.url, { status: err?.status || 0 });
      pages.push({ url: req.url, depth: req.depth, source: req.source, error: String(err?.message || err) });
    }
  }

  function pump() {
    while (active.size < CONCURRENT_TABS && queue.pending && queue.remaining > 0) {
      const req = queue.next();
      if (!req) break;
      const p = launch(req).finally(() => active.delete(p));
      active.add(p);
    }
  }
  pump();
  while (active.size > 0) { await Promise.race(active); pump(); }

  const inventory = buildInventory(pages, { seedUrl: startUrl, seedHost, maxUrls, crawlDepth, depthStats });

  // Generate both deliverables as blobs.
  const [docxBlob, xlsxBlob] = await Promise.all([
    buildScopeDocx(inventory),
    buildInventoryXlsx(inventory)
  ]);

  const inventoryId = `inv-${Date.now()}`;
  inventories.set(inventoryId, { inventory, files: { docx: docxBlob, xlsx: xlsxBlob } });

  await chrome.tabs.create({ url: chrome.runtime.getURL(`report/inventory.html?id=${inventoryId}`) });
  return { ok: true, inventoryId };
}

async function inventoryInNewTab(url, collectNextLinks) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id, TAB_TIMEOUT_MS);
    await sleep(SETTLE_MS);
    const sig = await collectTemplateSignature(tab.id);
    const signals = await collectContentSignals(tab.id);
    const fingerprint = await sha1Prefix(sig?.sigStr || "", 12);
    const out = {
      title: tab.title || "",
      template_id: fingerprint,
      url_cluster: sig?.urlCluster || "unknown",
      ...signals
    };
    if (collectNextLinks) {
      try { out.links = await collectNavLinks(tab.id); } catch { out.links = []; }
    }
    return out;
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

async function sha1Prefix(str, hex) {
  if (!str) return "";
  const bytes = new TextEncoder().encode(str);
  const digest = await crypto.subtle.digest("SHA-1", bytes);
  return [...new Uint8Array(digest)].map(b => b.toString(16).padStart(2, "0")).join("").slice(0, hex);
}

// Critical-path URLs we always add to the sample if the crawl found them.
const CRITICAL_PATH_TOKENS = [
  "home", "index", "login", "signin", "signup", "register",
  "contact", "search", "checkout", "cart", "account", "profile",
  "accessibility", "privacy", "terms", "sitemap"
];
function isCriticalPath(url) {
  try {
    const u = new URL(url);
    const path = u.pathname.toLowerCase();
    if (path === "/" || path === "") return "home";
    for (const tok of CRITICAL_PATH_TOKENS) {
      if (new RegExp(`(^|/)${tok}(/|$|\\.)`).test(path)) return tok;
    }
    return null;
  } catch { return null; }
}

function buildInventory(pages, meta) {
  // Group by template — fingerprint + url_cluster.
  const groups = new Map();
  const contentTypeSummary = {
    "Forms": 0, "Data Tables": 0, "Video": 0, "Audio": 0,
    "Iframes": 0, "Modals": 0, "Carousels": 0, "Tabs": 0,
    "Menus": 0, "Accordions": 0, "Datepickers": 0, "Dropdowns": 0,
    "PDF Links": 0, "Login": 0, "CAPTCHA": 0, "Shadow DOM": 0
  };
  const testsUnion = new Map(); // test → why

  for (const p of pages) {
    if (p.error) continue;
    const key = `${p.template_id}|${p.url_cluster}`;
    let g = groups.get(key);
    if (!g) {
      g = {
        template_id: p.template_id, url_cluster: p.url_cluster,
        page_count: 0, pages: [],
        sample_url: p.url, sample_title: p.title || "",
        flags: {}, recommendedTests: [], testSet: new Set(),
        aggregatedCounts: {}
      };
      groups.set(key, g);
    }
    g.page_count++;
    g.pages.push({ url: p.url, title: p.title || "" });
    // OR flags together; prefer first sample
    for (const [k, v] of Object.entries(p.flags || {})) {
      g.flags[k] = g.flags[k] || v;
    }
    for (const r of (p.recommendedTests || [])) {
      if (!g.testSet.has(r.test)) {
        g.testSet.add(r.test);
        g.recommendedTests.push(r);
      }
      if (!testsUnion.has(r.test)) testsUnion.set(r.test, r.why);
    }
    // Count content types across the corpus.
    if (p.flags?.hasForms) contentTypeSummary["Forms"]++;
    if (p.flags?.hasDataTable) contentTypeSummary["Data Tables"]++;
    if (p.flags?.hasVideo) contentTypeSummary["Video"]++;
    if (p.flags?.hasAudio) contentTypeSummary["Audio"]++;
    if (p.flags?.hasIframe) contentTypeSummary["Iframes"]++;
    if (p.flags?.hasModal) contentTypeSummary["Modals"]++;
    if (p.flags?.hasCarousel) contentTypeSummary["Carousels"]++;
    if (p.flags?.hasTabs) contentTypeSummary["Tabs"]++;
    if (p.flags?.hasMenu) contentTypeSummary["Menus"]++;
    if (p.flags?.hasAccordion) contentTypeSummary["Accordions"]++;
    if (p.flags?.hasDatepicker) contentTypeSummary["Datepickers"]++;
    if (p.flags?.hasDropdown) contentTypeSummary["Dropdowns"]++;
    if (p.flags?.hasPdfLinks) contentTypeSummary["PDF Links"]++;
    if (p.flags?.hasLogin) contentTypeSummary["Login"]++;
    if (p.flags?.hasCaptcha) contentTypeSummary["CAPTCHA"]++;
    if (p.flags?.hasShadowDom) contentTypeSummary["Shadow DOM"]++;
  }

  const templates = [...groups.values()]
    .map(g => {
      const signalBits = [];
      if (g.flags.hasForms) signalBits.push("forms");
      if (g.flags.hasDataTable) signalBits.push("tables");
      if (g.flags.hasVideo) signalBits.push("video");
      if (g.flags.hasAudio) signalBits.push("audio");
      if (g.flags.hasIframe) signalBits.push("iframe");
      if (g.flags.hasModal) signalBits.push("modal");
      if (g.flags.hasCarousel) signalBits.push("carousel");
      if (g.flags.hasTabs) signalBits.push("tabs");
      if (g.flags.hasMenu) signalBits.push("menu");
      if (g.flags.hasAccordion) signalBits.push("accordion");
      if (g.flags.hasDatepicker) signalBits.push("datepicker");
      if (g.flags.hasDropdown) signalBits.push("dropdown");
      if (g.flags.hasPdfLinks) signalBits.push("pdf-links");
      if (g.flags.hasLogin) signalBits.push("login");
      if (g.flags.hasCaptcha) signalBits.push("captcha");
      if (g.flags.hasShadowDom) signalBits.push("shadow-dom");
      return {
        template_id: g.template_id, url_cluster: g.url_cluster,
        page_count: g.page_count, sample_url: g.sample_url,
        sample_title: g.sample_title,
        flags: g.flags, recommendedTests: g.recommendedTests,
        contentSignalSummary: signalBits.join(", ") || "static content"
      };
    })
    .sort((a, b) => b.page_count - a.page_count);

  // Proposed sample: one URL per template + critical-path pages.
  const sampleSet = new Map();
  for (const t of templates) {
    sampleSet.set(t.sample_url, {
      url: t.sample_url, template_id: t.template_id, url_cluster: t.url_cluster,
      reason: `Template representative (${t.page_count} page${t.page_count === 1 ? "" : "s"})`,
      testCount: t.recommendedTests.length
    });
  }
  for (const p of pages) {
    if (p.error) continue;
    const tag = isCriticalPath(p.url);
    if (tag && !sampleSet.has(p.url)) {
      sampleSet.set(p.url, {
        url: p.url, template_id: p.template_id, url_cluster: p.url_cluster,
        reason: `Critical path — ${tag}`,
        testCount: (p.recommendedTests || []).length
      });
    }
  }
  const proposedSample = [...sampleSet.values()];

  return {
    meta: { ...meta, generatedAt: new Date().toISOString() },
    pages, templates, proposedSample, contentTypeSummary,
    recommendedTestsUnion: [...testsUnion.entries()].map(([test, why]) => ({ test, why }))
  };
}

async function downloadInventoryFile(inventoryId, kind) {
  const entry = inventories.get(inventoryId);
  if (!entry) return { ok: false, error: "Inventory expired" };
  const blob = entry.files[kind];
  if (!blob) return { ok: false, error: `No ${kind} file` };
  const dataUrl = await blobToDataUrl(blob);
  const host = entry.inventory.meta.seedHost;
  const stamp = entry.inventory.meta.generatedAt.replace(/[:.]/g, "-");
  const filename = kind === "docx"
    ? `enableuser-scope-${host}-${stamp}.docx`
    : `enableuser-inventory-${host}-${stamp}.xlsx`;
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  return { ok: true };
}

async function blobToDataUrl(blob) {
  const buf = await blob.arrayBuffer();
  const bytes = new Uint8Array(buf);
  // btoa chokes on non-ASCII; walk in 0x8000 chunks for large blobs.
  let binary = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode.apply(null, bytes.subarray(i, i + CHUNK));
  }
  return `data:${blob.type};base64,${btoa(binary)}`;
}

async function collectNavLinks(tabId) {
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: navSurfacedCollect,
      world: "ISOLATED"
    });
    return Array.isArray(result) ? result : [];
  } catch (err) {
    console.warn("[EU] collectNavLinks failed", err);
    return [];
  }
}

async function scanInExistingTab(tabId) {
  await injectAxe(tabId);
  return runContentScan(tabId);
}

async function scanInNewTab(url, collectNextLinks = false) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id, TAB_TIMEOUT_MS);
    await sleep(SETTLE_MS);
    await injectAxe(tab.id);
    const r = await runContentScan(tab.id);
    if (collectNextLinks) {
      try {
        r.links = await collectNavLinks(tab.id);
        console.log(`[EU]   ${url} → ${r.links.length} link(s)`);
      } catch (err) {
        console.warn(`[EU]   ${url} → collect failed`, err);
        r.links = [];
      }
    }
    return r;
  } finally {
    try { await chrome.tabs.remove(tab.id); } catch {}
  }
}

async function injectAxe(tabId) {
  // Inject axe-core + our custom check bundles together. They attach to
  // window.EU_IndiaChecks / window.EU_GIGWChecks so the content-script can
  // merge their output into the axe results.
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["lib/axe.min.js", "lib/india-checks.js", "lib/gigw-checks.js"],
    world: "ISOLATED"
  });
}

// Inventory mode: no axe — just content-signals. Runs in the same isolated
// world and returns whatever the injected function produces.
async function collectContentSignals(tabId) {
  await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    files: ["lib/content-signals.js"],
    world: "ISOLATED"
  });
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: "ISOLATED",
    func: () => (window.EU_ContentSignals ? window.EU_ContentSignals.collect() : null)
  });
  return result || null;
}

// Template fingerprint is the same algorithm used in the audit path, extracted
// so inventory mode can compute it without loading axe (500KB).
async function collectTemplateSignature(tabId) {
  const [{ result }] = await chrome.scripting.executeScript({
    target: { tabId, allFrames: false },
    world: "ISOLATED",
    func: computeTemplateFingerprintInline
  });
  return result || null;
}

// Serialisable standalone function (no imports) — executeScript ships it as
// text to the page. Mirrors what content-script.js does for template signals,
// including shadow-DOM traversal so audit-mode and inventory-mode fingerprints
// stay comparable on web-component-heavy pages.
function computeTemplateFingerprintInline() {
  const CSS_IN_JS_HASH = /^(?:jsx-|css-|sc-|emotion-|mui-|tw-|chakra-|_[a-zA-Z0-9]+_)[A-Za-z0-9]{4,}$/;
  const STATE_PREFIXES = /^(?:is-|has-|active$|open$|closed$|selected$|hover$|focus$|disabled$|js-)/;
  const UTILITY_NOISE = /^(?:flex|grid|row|col|mt|mb|mx|my|pt|pb|px|py|text-|bg-|border-|w-|h-|space-|gap-)\d/;
  const firstClasses = (el, n) => {
    const raw = (el.className || "").toString().trim();
    if (!raw) return "";
    return raw.split(/\s+/)
      .filter(c => c.length > 1)
      .filter(c => !/\d{4,}/.test(c))
      .filter(c => !CSS_IN_JS_HASH.test(c))
      .filter(c => !STATE_PREFIXES.test(c))
      .filter(c => !UTILITY_NOISE.test(c))
      .slice(0, n).join(" ");
  };
  const WALK_CAP = 30000;
  function qsaDeep(selector) {
    const out = [];
    let visited = 0;
    (function walk(node) {
      if (!node || visited > WALK_CAP) return;
      if (typeof node.querySelectorAll !== "function") return;
      try { for (const el of node.querySelectorAll(selector)) out.push(el); } catch {}
      const children = node.querySelectorAll("*");
      for (const el of children) {
        visited++;
        if (visited > WALK_CAP) return;
        if (el.shadowRoot) walk(el.shadowRoot);
      }
    })(document);
    return out;
  }
  const sig = [];
  const landmarkTags = ["header","nav","main","article","aside","footer","section","form","dialog","details","summary","figure","figcaption","table","thead","tbody","tfoot","h1","h2","h3","h4","h5","h6"];
  for (const tag of landmarkTags) {
    for (const el of qsaDeep(tag)) {
      sig.push(`${el.tagName.toLowerCase()}:${el.getAttribute("role")||""}:${firstClasses(el,3)}`);
    }
  }
  for (const el of qsaDeep("[role]")) {
    sig.push(`${el.tagName.toLowerCase()}:${el.getAttribute("role")||""}:${firstClasses(el,3)}`);
  }
  const hCounts = [1,2,3,4,5,6].map(n => qsaDeep(`h${n}`).length);
  sig.push("H:" + hCounts.join("-"));
  const LAYOUT = ["layout","template","container","wrapper","grid","flex","row","col-","block","module","widget","component","page-","content"];
  const seen = new Set();
  for (const p of LAYOUT) {
    for (const el of qsaDeep(`[class*="${p}" i]`)) {
      const k = `${el.tagName.toLowerCase()}::${firstClasses(el,3)}`;
      if (!seen.has(k)) { seen.add(k); sig.push(k); }
    }
  }
  const sigStr = sig.join("|");

  const clusterUrl = (href) => {
    let u; try { u = new URL(href); } catch { return "unknown"; }
    const path = u.pathname.toLowerCase().replace(/^\/+|\/+$/g,"");
    const parts = path.split("/").filter(Boolean);
    if (!parts.length) return "home";
    const last = parts[parts.length-1];
    if (/[0-9a-f]{8}-[0-9a-f]{4}/.test(last) || /^\d+$/.test(last) || /\d{4}[/-]\d{2}/.test(path)) return `/${parts[0]}/[dynamic-id]`;
    if (parts.length >= 3) return `/${parts[0]}/${parts[1]}/[detail]`;
    if (parts.length === 2) return `/${parts[0]}/${parts[1]}`;
    return `/${parts[0]}`;
  };
  return { sigStr, urlCluster: clusterUrl(location.href) };
}

function runContentScan(tabId) {
  return new Promise(async (resolve, reject) => {
    const timeoutId = setTimeout(() => {
      pending.delete(tabId);
      reject(new Error("scan timeout"));
    }, TAB_TIMEOUT_MS);
    pending.set(tabId, { resolve, reject, timeoutId });
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files: ["content-script.js"],
        world: "ISOLATED"
      });
    } catch (err) {
      clearTimeout(timeoutId);
      pending.delete(tabId);
      reject(err);
    }
  });
}

function handleResult(payload, sender) {
  const tabId = sender?.tab?.id;
  const entry = pending.get(tabId);
  if (!entry) return { ok: true };
  clearTimeout(entry.timeoutId);
  pending.delete(tabId);
  entry.resolve(payload);
  return { ok: true };
}

function handleError(payload, sender) {
  const tabId = sender?.tab?.id;
  const entry = pending.get(tabId);
  if (!entry) return { ok: true };
  clearTimeout(entry.timeoutId);
  pending.delete(tabId);
  entry.reject(new Error(payload?.reason || "content script error"));
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────────────
// buildReport: preserves EVERY axe field. Row shapes deliberately include
// full objects (arrays, nested structures) — the report renderer and CSV
// exporter handle serialisation. No truncation anywhere.
// ─────────────────────────────────────────────────────────────────────────────

function buildReport(pages, meta) {
  const issueRows = [];
  const passRows = [];
  const incompleteRows = [];
  const inapplicableRows = [];
  const checkRows = [];   // one row per {node × check-slot × check} — the deepest detail
  const envRows = [];     // per-page axe test engine / environment / toolOptions

  const criterionStats = new Map();
  for (const c of ALL_AA_CRITERIA) {
    criterionStats.set(c.num, { pagesPassed: new Set(), pagesFailed: new Set(), totalViolations: 0 });
  }

  // Helper: expand one rule category into flat rows without losing any field.
  const pushCategoryRows = (page, rules, category, target) => {
    for (const r of rules || []) {
      for (const n of r.nodes || []) {
        const row = {
          url: page.url,
          page_title: page.title || "",
          scan_started_at: page.scanStartedAt || "",
          category,
          rule_id: r.ruleId,
          rule_impact: r.impact || "",
          rule_description: r.description || "",
          rule_help: r.help || "",
          rule_help_url: r.helpUrl || "",
          rule_tags: (r.tags || []).join(" "),
          node_impact: n.impact || "",
          node_failure_summary: n.failureSummary || "",
          node_html: n.html || "",
          node_target: (n.target || []).join(" "),
          node_target_array: n.target || [],
          node_target_joined: n.targetJoined || (n.target || []).join(" "),
          node_ancestry: (n.ancestry || []).join(" "),
          node_xpath: (n.xpath || []).join(" "),
          checks_any: n.any || [],
          checks_all: n.all || [],
          checks_none: n.none || []
        };
        target.push(row);

        // One flat row per individual check within the node — this is the
        // "deepest" level axe exposes (message + data per check), which is
        // what makes the output useful for triage.
        for (const slot of ["any", "all", "none"]) {
          for (const c of n[slot] || []) {
            checkRows.push({
              url: page.url,
              category,
              rule_id: r.ruleId,
              rule_impact: r.impact || "",
              node_target: (n.target || []).join(" "),
              node_html: n.html || "",
              check_slot: slot,
              check_id: c.id || "",
              check_impact: c.impact || "",
              check_message: c.message || "",
              check_data: c.data === undefined || c.data === null ? "" :
                (typeof c.data === "object" ? JSON.stringify(c.data) : String(c.data)),
              related_nodes_count: (c.relatedNodes || []).length,
              related_targets: (c.relatedNodes || [])
                .map(rn => Array.isArray(rn.target) ? rn.target.join(" ") : String(rn.target || ""))
                .join(" || "),
              related_html: (c.relatedNodes || []).map(rn => rn.html || "").join(" || ")
            });
          }
        }
      }
    }
  };

  for (const p of pages) {
    const pageUrl = p.url;

    // Per-page environment row — one per page scanned.
    envRows.push({
      url: pageUrl,
      page_title: p.title || "",
      scan_started_at: p.scanStartedAt || "",
      scan_duration_ms: p.scanDurationMs ?? "",
      axe_timestamp: p.axeTimestamp || "",
      axe_version: p.testEngine?.version || "",
      axe_name: p.testEngine?.name || "",
      test_runner: p.testRunner?.name || "",
      user_agent: p.testEnvironment?.userAgent || "",
      window_width: p.testEnvironment?.windowWidth ?? "",
      window_height: p.testEnvironment?.windowHeight ?? "",
      orientation_angle: p.testEnvironment?.orientationAngle ?? "",
      orientation_type: p.testEnvironment?.orientationType || "",
      tool_options: p.toolOptions ? JSON.stringify(p.toolOptions) : "",
      error: p.error || ""
    });

    const failed = new Set();

    // Violations: also drive the WCAG criterion pass/fail tally and issueRows.
    for (const v of p.violations || []) {
      const crits = extractCriteriaFromTags(v.tags || []);
      // Custom rules (india-checks / gigw-checks) may not carry wcagXXX tags
      // but still reference a WCAG criterion via their rule id. If the
      // tag-extractor produced no criteria, we synthesise a single row with
      // empty WCAG fields so the violation still appears.
      const critList = crits.length ? crits : [{ num: "", level: "", name: "" }];
      for (const n of v.nodes || []) {
        for (const crit of critList) {
          if (crit.num) {
            failed.add(crit.num);
            const st = criterionStats.get(crit.num);
            if (st) { st.pagesFailed.add(pageUrl); st.totalViolations++; }
          }
          const xref = crit.num ? standardsFor(crit.num) : null;
          issueRows.push({
            url: pageUrl,
            page_title: p.title || "",
            wcag_criterion: crit.num,
            wcag_level: crit.level,
            wcag_name: crit.name,
            // Cross-framework clause references (null when SC isn't covered
            // by that framework — Section 508 pre-WCAG-2.1 carve-outs etc).
            gigw_clause:      xref?.gigw       || "",
            is17802_clause:   xref?.is17802    || "",
            en301549_clause:  xref?.en301549   || "",
            section508_ref:   xref?.section508 || "",
            ada_ref:          xref?.ada        || "",
            rule_id: v.ruleId,
            rule_impact: v.impact || "",
            rule_description: v.description || "",
            rule_help: v.help || "",
            rule_tags: (v.tags || []).join(" "),
            rule_source: v.ruleId && (v.ruleId.startsWith("india-") || v.ruleId.startsWith("gigw-")) ? "custom" : "axe-core",
            impact: n.impact || v.impact || "minor",
            selector: (n.target || []).join(" "),
            target_array: n.target || [],
            ancestry: (n.ancestry || []).join(" "),
            xpath: (n.xpath || []).join(" "),
            html_snippet: n.html || "",
            failure_summary: n.failureSummary || "",
            help_url: v.helpUrl || "",
            checks_any: n.any || [],
            checks_all: n.all || [],
            checks_none: n.none || []
          });
        }
      }
    }

    pushCategoryRows(p, p.passes, "pass", passRows);
    pushCategoryRows(p, p.incomplete, "incomplete", incompleteRows);
    pushCategoryRows(p, p.inapplicable, "inapplicable", inapplicableRows);
    // Violations were already processed above for WCAG stats + issueRows, but
    // we still flatten them into checkRows so the deep-check CSV covers all
    // four categories uniformly.
    pushCategoryRows(p, p.violations, "violation", []);

    for (const c of ALL_AA_CRITERIA) {
      if (!failed.has(c.num)) {
        const st = criterionStats.get(c.num);
        if (st && !p.error) st.pagesPassed.add(pageUrl);
      }
    }
  }

  const summaryRows = ALL_AA_CRITERIA.map(c => {
    const st = criterionStats.get(c.num);
    return {
      wcag_criterion: c.num,
      level: c.level,
      name: c.name,
      status: st.pagesFailed.size === 0 ? "PASS" : "FAIL",
      pages_passed: st.pagesPassed.size,
      pages_failed: st.pagesFailed.size,
      total_violations: st.totalViolations
    };
  });

  const pagesRows = pages.map(p => ({
    url: p.url,
    page_title: p.title || "",
    depth: p.depth ?? "",
    source: p.source || "",
    status: p.error ? "failed" : "scanned",
    violations: sumNodes(p.violations),
    passes: sumNodes(p.passes),
    incomplete: sumNodes(p.incomplete),
    inapplicable: sumNodes(p.inapplicable),
    violation_rules: (p.violations || []).length,
    pass_rules: (p.passes || []).length,
    incomplete_rules: (p.incomplete || []).length,
    inapplicable_rules: (p.inapplicable || []).length,
    template_id: p.template?.fingerprint || "",
    url_cluster: p.template?.urlCluster || "",
    text_hash: p.template?.textHash || "",
    text_length: p.template?.textLength ?? "",
    signature_items: p.template?.signatureItems ?? "",
    elem_headings: p.template?.elementCounts?.headings ?? "",
    elem_sections: p.template?.elementCounts?.sections ?? "",
    elem_forms: p.template?.elementCounts?.forms ?? "",
    elem_aria_roles: p.template?.elementCounts?.ariaRoles ?? "",
    elem_links: p.template?.elementCounts?.links ?? "",
    elem_images: p.template?.elementCounts?.images ?? "",
    elem_buttons: p.template?.elementCounts?.buttons ?? "",
    elem_inputs: p.template?.elementCounts?.inputs ?? "",
    scan_duration_ms: p.scanDurationMs ?? "",
    axe_version: p.testEngine?.version || "",
    error: p.error || ""
  }));

  // ── Group pages by template (fingerprint + urlCluster) ──
  const templateGroups = new Map();
  for (const p of pages) {
    const fp = p.template?.fingerprint || "unknown";
    const cluster = p.template?.urlCluster || "unknown";
    const key = `${fp}|${cluster}`;
    let g = templateGroups.get(key);
    if (!g) {
      g = {
        template_id: fp,
        url_cluster: cluster,
        page_count: 0,
        pages: [],
        sample_url: p.url,
        sample_title: p.title || "",
        total_violations: 0,
        impact_counts: { critical: 0, serious: 0, moderate: 0, minor: 0 },
        unique_rules: new Set()
      };
      templateGroups.set(key, g);
    }
    g.page_count++;
    g.pages.push(p.url);
    for (const v of p.violations || []) {
      for (const n of v.nodes || []) {
        g.total_violations++;
        const imp = n.impact || v.impact || "minor";
        if (g.impact_counts[imp] != null) g.impact_counts[imp]++;
        g.unique_rules.add(v.ruleId);
      }
    }
  }
  const templatesRows = [...templateGroups.values()]
    .map(g => ({
      template_id: g.template_id,
      url_cluster: g.url_cluster,
      page_count: g.page_count,
      sample_url: g.sample_url,
      sample_title: g.sample_title,
      total_violations: g.total_violations,
      critical: g.impact_counts.critical,
      serious: g.impact_counts.serious,
      moderate: g.impact_counts.moderate,
      minor: g.impact_counts.minor,
      unique_rules: g.unique_rules.size,
      pages: g.pages
    }))
    .sort((a, b) => (b.page_count - a.page_count) || (b.total_violations - a.total_violations));

  // ── Per-profile conformance ─────────────────────────────────────────────
  // For each compliance profile (WCAG 2.1 AA, IS 17802, GIGW 3.0, EN 301 549,
  // Section 508, ADA), compute: which in-scope SCs have failures across the
  // corpus. Produces a compact table the report can render as "Conformance
  // by Standard" and the ACR / VPAT generator can consume directly.
  const profilesRows = PROFILE_KEYS.map(key => {
    const p = PROFILES[key];
    let applicable = 0, failed = 0, passed = 0, violations = 0;
    const failingClauses = [];
    for (const c of ALL_AA_CRITERIA) {
      if (!isInProfile(key, c.num)) continue;
      applicable++;
      const st = criterionStats.get(c.num);
      if (st && st.pagesFailed.size > 0) {
        failed++;
        violations += st.totalViolations;
        failingClauses.push({
          wcag: c.num,
          name: c.name,
          level: c.level,
          clause: profileClause(key, c.num),
          pages_failed: st.pagesFailed.size,
          total_violations: st.totalViolations
        });
      } else if (st) {
        passed++;
      }
    }
    const conformance = applicable === 0 ? "N/A" :
      failed === 0 ? "Fully conformant" :
      failed < applicable * 0.1 ? "Partially conformant (≥90% SCs pass)" :
      "Does not conform";
    return {
      profile_key: key,
      profile_label: p.label,
      applicable_criteria: applicable,
      passed_criteria: passed,
      failed_criteria: failed,
      total_violations: violations,
      conformance_status: conformance,
      failing_clauses: failingClauses.sort((a, b) => b.total_violations - a.total_violations)
    };
  });

  return {
    meta: { ...meta, generatedAt: new Date().toISOString(), totalPages: pages.length, totalTemplates: templatesRows.length },
    summaryRows,
    issueRows,
    passRows,
    incompleteRows,
    inapplicableRows,
    checkRows,
    envRows,
    pagesRows,
    templatesRows,
    profilesRows,
    pages
  };
}

function sumNodes(rules) {
  let n = 0;
  for (const r of rules || []) n += (r.nodes || []).length;
  return n;
}

async function downloadCsv(reportId) {
  const report = reports.get(reportId);
  if (!report) return { ok: false, error: "Report expired" };

  // Shared column sets — full fidelity, no truncation. Objects/arrays are
  // serialised by toCsv via JSON.stringify in wrapCell (see csv-writer.js).
  const stringify = v => {
    if (v === null || v === undefined) return "";
    if (typeof v === "string" || typeof v === "number" || typeof v === "boolean") return v;
    try { return JSON.stringify(v); } catch { return String(v); }
  };
  const flatten = (rows, cols) => rows.map(r => {
    const out = {};
    for (const k of cols) out[k] = stringify(r[k]);
    return out;
  });

  const summaryCols = ["wcag_criterion", "level", "name", "status", "pages_passed", "pages_failed", "total_violations"];
  const summaryCsv = toCsv(summaryCols, report.summaryRows);

  const issueCols = [
    "url", "page_title",
    "wcag_criterion", "wcag_level", "wcag_name",
    "gigw_clause", "is17802_clause", "en301549_clause", "section508_ref", "ada_ref",
    "rule_id", "rule_source", "rule_impact", "rule_description", "rule_help", "rule_tags",
    "impact", "selector", "ancestry", "xpath", "html_snippet",
    "failure_summary", "help_url",
    "checks_any", "checks_all", "checks_none"
  ];
  const issuesCsv = toCsv(issueCols, flatten(report.issueRows, issueCols));

  const profilesCols = [
    "profile_key", "profile_label", "applicable_criteria", "passed_criteria",
    "failed_criteria", "total_violations", "conformance_status"
  ];
  const profilesCsv = toCsv(profilesCols, flatten(report.profilesRows || [], profilesCols));

  const categoryCols = [
    "url", "page_title", "scan_started_at",
    "category", "rule_id", "rule_impact", "rule_description", "rule_help", "rule_help_url", "rule_tags",
    "node_impact", "node_failure_summary", "node_html",
    "node_target", "node_ancestry", "node_xpath",
    "checks_any", "checks_all", "checks_none"
  ];
  const passesCsv = toCsv(categoryCols, flatten(report.passRows, categoryCols));
  const incompleteCsv = toCsv(categoryCols, flatten(report.incompleteRows, categoryCols));
  const inapplicableCsv = toCsv(categoryCols, flatten(report.inapplicableRows, categoryCols));

  const checkCols = [
    "url", "category", "rule_id", "rule_impact",
    "node_target", "node_html",
    "check_slot", "check_id", "check_impact", "check_message", "check_data",
    "related_nodes_count", "related_targets", "related_html"
  ];
  const checksCsv = toCsv(checkCols, report.checkRows);

  const pagesCols = [
    "url", "page_title", "depth", "source", "status",
    "violations", "passes", "incomplete", "inapplicable",
    "violation_rules", "pass_rules", "incomplete_rules", "inapplicable_rules",
    "template_id", "url_cluster", "text_hash", "text_length", "signature_items",
    "elem_headings", "elem_sections", "elem_forms", "elem_aria_roles",
    "elem_links", "elem_images", "elem_buttons", "elem_inputs",
    "scan_duration_ms", "axe_version", "error"
  ];
  const pagesCsv = toCsv(pagesCols, report.pagesRows);

  const templatesCols = [
    "template_id", "url_cluster", "page_count", "sample_url", "sample_title",
    "total_violations", "critical", "serious", "moderate", "minor", "unique_rules", "pages"
  ];
  const templatesCsv = toCsv(
    templatesCols,
    (report.templatesRows || []).map(t => ({ ...t, pages: (t.pages || []).join(" || ") }))
  );

  const envCols = [
    "url", "page_title", "scan_started_at", "scan_duration_ms",
    "axe_timestamp", "axe_version", "axe_name", "test_runner",
    "user_agent", "window_width", "window_height",
    "orientation_angle", "orientation_type", "tool_options", "error"
  ];
  const envCsv = toCsv(envCols, report.envRows);

  const combined =
    `# EnableUser Accessibility Report\r\n` +
    `# Generated: ${report.meta.generatedAt}\r\n` +
    `# Seed URL: ${report.meta.seedUrl}\r\n` +
    `# Mode: ${report.meta.mode}\r\n` +
    `# Pages scanned: ${report.meta.totalPages}\r\n` +
    `# Templates detected: ${report.meta.totalTemplates ?? 0}\r\n` +
    (report.meta.discoveryStats
      ? `# Discovery: nav=${report.meta.discoveryStats.nav} body=${report.meta.discoveryStats.body} sitemap=${report.meta.discoveryStats.sitemap} hreflang=${report.meta.discoveryStats.hreflang} paths=${report.meta.discoveryStats.commonPaths}\r\n`
      : ``) +
    `\r\n## WCAG 2.1 AA Summary\r\n` + summaryCsv +
    `\r\n\r\n## Conformance by Standard (WCAG / IS 17802 / GIGW / EN 301 549 / Section 508 / ADA)\r\n` + profilesCsv +
    `\r\n\r\n## Templates\r\n` + templatesCsv +
    `\r\n\r\n## Violations (one row per violation × WCAG criterion × node)\r\n` + issuesCsv +
    `\r\n\r\n## Passes (one row per node)\r\n` + passesCsv +
    `\r\n\r\n## Incomplete (one row per node)\r\n` + incompleteCsv +
    `\r\n\r\n## Inapplicable (one row per rule)\r\n` + inapplicableCsv +
    `\r\n\r\n## Check Details (one row per any/all/none check per node, all categories)\r\n` + checksCsv +
    `\r\n\r\n## Pages\r\n` + pagesCsv +
    `\r\n\r\n## Scan Environment (one row per page — axe engine + window + UA)\r\n` + envCsv;

  const dataUrl = "data:text/csv;charset=utf-8," + encodeURIComponent(combined);
  const host = safeHost(report.meta.seedUrl);
  const stamp = report.meta.generatedAt.replace(/[:.]/g, "-");
  await chrome.downloads.download({
    url: dataUrl,
    filename: `enableuser-report-${host}-${stamp}.csv`,
    saveAs: false
  });
  return { ok: true };
}

function safeHost(u) {
  try { return new URL(u).hostname.replace(/[^a-z0-9.-]/gi, "_"); } catch { return "site"; }
}
function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }
function safeOrigin(u) { try { return new URL(u).origin; } catch { return null; } }

function waitForTabComplete(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(handler);
      reject(new Error("tab load timeout"));
    }, timeoutMs);
    function handler(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(handler);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(handler);
    chrome.tabs.get(tabId).then(tab => {
      if (tab.status === "complete") {
        clearTimeout(t);
        chrome.tabs.onUpdated.removeListener(handler);
        resolve();
      }
    }).catch(() => {});
  });
}
