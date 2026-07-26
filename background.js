import { toCsv } from "./lib/csv-writer.js";
import { ALL_AA_CRITERIA, extractCriteriaFromTags, CRITERION_BY_NUM } from "./lib/wcag-tags.js";
import { standardsFor, PROFILES, PROFILE_KEYS, isInProfile, profileClause, tagsForProfile, criteriaForProfile, versionForProfile } from "./lib/standards.js";
import {
  RequestQueue,
  RateLimiter,
  canonicalize,
  parseRetryAfter,
  retryWithBackoff
} from "./lib/request-queue.js";
import {
  discoverSeedsFromOrigin,
  discoverHomepageLinks,
  discoverFeeds,
  sampleByPathBucket,
  navSurfacedCollect
} from "./lib/discovery.js";
import { probeAllCmsApis } from "./lib/cms-probes.js";
import { buildScopeDocx } from "./lib/docx-writer.js";
import { buildInventoryXlsx, buildClustersXlsx, buildAuditXlsx, buildReportXlsx } from "./lib/xlsx-writer.js";
import { classifyTemplate, templateSlugKey } from "./lib/template-classifier.js";
import { auditPdfUrls, pdfAuditToIssues } from "./lib/pdf-audit.js";
import { auditOfficeUrls, officeAuditToIssues } from "./lib/office-audit.js";
import { detectBrokenLinks, collectRendered404Signals, rendered404Verdict } from "./lib/link-check.js";

const DEFAULT_MAX_URLS = 50;
const DEFAULT_CRAWL_DEPTH = 1;
// Intentionally NO HARD_MAX_URLS ceiling. The user's explicit direction: a
// professional audit tool doesn't impose arbitrary limits on the operator.
// We floor at 1 to prevent a zero-URL crawl, and let the operator set any
// upper number they're willing to wait for. Concurrency + rate-limiter keep
// the target site safe regardless of total URL count.
// CONCURRENT_TABS is the GLOBAL cap on how many worker tabs run in
// parallel across the whole crawl, regardless of origin. Each tab spins
// up its own Chromium renderer + axe context, so memory cost is real
// (~100–200 MB per content-heavy page).
//
// v0.4.9 — lowered 200 → 10. The old 200 was only ever reachable on
// MULTI-origin runs: on a single-origin crawl PER_ORIGIN_TABS (8) is the
// real limiter, so single-site behaviour is unchanged by this. But the
// paste-a-list ("template check") mode routinely receives URLs spread
// across many different domains, where the per-origin cap does nothing
// (each host only has a few URLs) and this global cap is the ONLY thing
// holding concurrency down. A 200-URL paste therefore opened ~200 tabs at
// once (20–40 GB peak), Chrome's renderer/network pool collapsed, and
// pages that were perfectly reachable came back as load failures /
// "URL not reachable". A modest global cap makes every mode behave the
// way the operator expects: open a handful of tabs, let each fully
// load → settle → audit → save its result, then pull the next URL off the
// queue. The RateLimiter still governs per-site pacing (backoff on
// 429/503, same-host politeness) and the injectAxe retry wrapper (see
// lower in file) still handles transient preload races.
//
// v0.4.2 — adaptive settle window. The wait between "tab reported
// navigation complete" and (a) the settled-URL dedup check, (b) axe
// injection, (c) the full-page screenshot used to be a fixed 15 s sleep
// (SETTLE_MS). It is now a MutationObserver-based DOM-quiet wait
// (adaptiveSettle, ported from SiteCrawler v1.1.0): every page waits at
// least SETTLE_MIN_MS so cookie-consent banners, GDPR popups, and
// client-side redirect JS get time to fire, then the wait ends as soon
// as the DOM has been quiet for SETTLE_QUIET_MS — capped at
// SETTLE_MAX_MS for pages that mutate forever (carousels, tickers,
// animation loops). v0.4.5 — SETTLE_MIN_MS lowered 5s → 1s on operator
// direction: the 2s DOM-quiet requirement is the real floor (a page can't
// finish before ~2s of stability anyway), so static pages now settle in
// ~2s while dynamic pages still get up to the 10s cap.
const CONCURRENT_TABS = 10;
const TAB_TIMEOUT_MS = 60_000;
const SETTLE_MIN_MS = 1_000;
const SETTLE_QUIET_MS = 2_000;
const SETTLE_MAX_MS = 10_000;
// v12.2 — hard per-worker ceiling. waitForTabComplete (60s) + settle (≤10s)
// + axe run + screenshot + content-signals + link harvest should complete
// in well under this on any well-behaved page. If a worker exceeds it,
// something genuinely pathological has happened (hung debugger attach,
// unreachable extension message bus, runaway JS on the page) and we
// force-abandon so the pool can move on instead of leaving the tab open
// indefinitely. See withTimeout() below.
const WORKER_HARD_TIMEOUT_MS = 150_000;
// Per-origin concurrency cap. CONCURRENT_TABS (10) is the GLOBAL worker
// count; this caps how many of those may target the SAME host at once, so
// a single-origin crawl can't slam one server's per-IP rate limit or
// saturate Chrome's renderer pool (which surfaced as "frame was removed" /
// "Cannot access contents" before axe ever ran). With the global cap now
// 10, single-origin crawls run at min(10, 8) = 8; the per-origin cap is
// the binding limit there, exactly as before. On a mixed paste list the
// global cap of 10 is what keeps total tab count sane.
const PER_ORIGIN_TABS = 8;
// v0.4.3 — circuit breaker (ported from SiteCrawler v1.1.0). If this many
// URLs in a row fail (site down, auth wall hit mid-crawl, network dropped),
// stop launching new workers instead of grinding through the whole queue
// producing error rows. In-flight workers finish; the report notes the trip.
const ERROR_STREAK_LIMIT = 20;
// v0.4.3 — checkpoint cadence. During an inventory crawl the accumulated
// pages (minus screenshots) are persisted to chrome.storage.local every
// N completed URLs, so a service-worker death / browser crash mid-crawl
// leaves a recoverable partial result instead of losing everything.
const CHECKPOINT_EVERY = 20;

// axe runOnly tags for the in-progress scan. Set at the start of each scan
// handler from the operator-selected profile (tagsForProfile) and read by
// runContentScan, which pushes it into the page via window.__EU_SCAN_OPTS so
// content-script.js runs the correct WCAG version (2.0 / 2.1 / 2.2). Only one
// scan runs at a time (the popup disables its buttons while scanning), so a
// module-level value is safe.
let ACTIVE_AXE_TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"];
// Per-check toggles + overlay-dismissal flag for the in-progress scan, set by
// each scan handler from the popup options and pushed to the page (with the tag
// set) by runContentScan via window.__EU_SCAN_OPTS. v0.4.8 — media, PDF/Office,
// and visual-state audits are opt-in (default OFF); overlay dismissal +
// audit-both also default OFF. Default recipe = axe-core only.
let ACTIVE_CHECKS = { axe: true, india: true, media: false, is17802: true, pdfOffice: false, visual: false };
let ACTIVE_DISMISS = false;
let ACTIVE_AUDIT_BOTH = false;
// v0.4.3 — screenshots are now opt-in. Full-page + element capture via the
// debugger API is the single heaviest per-page cost after axe itself and
// makes large-site crawls impractical; default-off gives a findings+Excel
// fast path. The popup exposes a "Capture screenshots" checkbox.
let ACTIVE_SCREENSHOTS = false;
// v0.4.3 — "real pages only" discovery (SiteCrawler-style). When on,
// seedDiscovery skips sitemap.xml / robots.txt / RSS-Atom feeds / CMS API
// probes and the crawl follows only links that actually appear on pages
// (nav + body anchors). Slower to reach deep pages, but the URL list
// contains only genuinely linked, reachable pages — no stale sitemap
// entries, no feed archives, no API-only junk URLs.
let ACTIVE_LINKS_ONLY = false;
// v0.4.4 — internal broken-link detection (default ON). After the crawl,
// every unique internal link target harvested from every scanned page is
// status-checked (hard 404s, soft 404s via a not-found fingerprint probe,
// dead redirects to the homepage). Results land in a "Broken Links" sheet.
let ACTIVE_LINKCHECK = true;
// v0.4.4 — rendered not-found baseline for the DOM soft-404 layer. Set by
// probeRendered404() at scan start (a worker tab renders a nonexistent URL
// so we learn what the site's not-found page looks like AFTER JavaScript
// runs — the only reliable signal on SPA sites). null = no baseline; the
// per-page wording heuristic still applies.
let ACTIVE_R404 = null;

// Open a worker tab on a guaranteed-nonexistent URL, let it fully render
// (adaptive settle), and capture the rendered not-found signature.
async function probeRendered404(origin) {
  if (!origin) return null;
  const url = `${origin}/eu404probe-${Math.random().toString(36).slice(2, 12)}`;
  let tab = null;
  try {
    tab = await createWorkerTab(url);
    await waitForTabComplete(tab.id, TAB_TIMEOUT_MS);
    await adaptiveSettle(tab.id);
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: collectRendered404Signals
    });
    const sig = results?.[0]?.result;
    if (!sig) return null;
    console.log(`[EU] rendered 404 probe — title="${sig.title}" textLen=${sig.textLen} shingles=${sig.shingleHashes?.length || 0}`);
    return { title: sig.title || "", shingles: new Set(sig.shingleHashes || []), textLen: sig.textLen || 0 };
  } catch (err) {
    console.warn("[EU] rendered 404 probe failed:", err?.message || err);
    return null;
  } finally {
    if (tab) { try { await chrome.tabs.remove(tab.id); } catch {} }
  }
}

// Run the rendered-DOM soft-404 check on an open worker tab. Returns a
// verdict object or null. Never throws — a failed collection just means
// no rendered verdict for this page.
async function checkRendered404(tabId) {
  if (!ACTIVE_LINKCHECK) return null;
  try {
    const results = await chrome.scripting.executeScript({ target: { tabId }, func: collectRendered404Signals });
    return rendered404Verdict(results?.[0]?.result, ACTIVE_R404);
  } catch { return null; }
}

// Fold rendered-DOM soft-404 page verdicts into the fetch-layer results so
// the "Broken Links" sheet carries both. Fetch-layer rows win on URL clash
// (the rendered verdict is appended to their detail instead).
function mergeRenderedVerdicts(brokenLinks, pages, linkGraph) {
  const flagged = (pages || []).filter(p => p && p.soft404 && !p.error);
  if (!flagged.length) return brokenLinks;
  const out = brokenLinks || {
    checked: 0, totalTargets: 0, truncated: false, okCount: 0,
    brokenCount: 0, notFoundMode: "rendered-only", probeStatuses: [], rows: []
  };
  const byUrl = new Map(out.rows.map(r => [r.url, r]));
  for (const p of flagged) {
    const existing = byUrl.get(p.url) || (p.finalUrl && byUrl.get(p.finalUrl));
    if (existing) {
      existing.detail += ` | ${p.soft404.detail}`;
      continue;
    }
    const entry = linkGraph ? (linkGraph.get(p.url) || (p.finalUrl && linkGraph.get(p.finalUrl))) : null;
    const sources = entry ? [...entry.sources.entries()] : [];
    out.rows.push({
      url: p.url,
      classification: p.soft404.kind,
      detail: p.soft404.detail,
      status: 200,
      final_url: (p.finalUrl && p.finalUrl !== p.url) ? p.finalUrl : "",
      source_count: sources.length,
      sources: sources.map(([src, text]) => text ? `${src}  ["${text}"]` : src).join("\n"),
      first_source: sources[0]?.[0] || "",
      first_link_text: sources[0]?.[1] || ""
    });
    out.brokenCount++;
  }
  return out;
}

// v0.4.5 — settings echo. Snapshot of exactly what configuration is running,
// attached to the report/inventory and emitted as a "Scan Settings" sheet in
// the Excel workbooks — so nobody has to guess what a given report ran with.
function settingsEcho(mode, { profile, maxUrls, crawlDepth } = {}) {
  let version = "";
  try { version = chrome.runtime.getManifest().version; } catch {}
  return {
    "Mode": mode,
    "Extension version": version,
    "Standard profile": profile || "",
    "axe tags": ACTIVE_AXE_TAGS.join(", "),
    "Max URLs": String(maxUrls ?? ""),
    "Crawl depth": Number.isFinite(crawlDepth) ? String(crawlDepth) : "unbounded",
    "axe-core checks": ACTIVE_CHECKS.axe ? "on" : "off",
    "India checks": ACTIVE_CHECKS.india ? "on" : "off",
    "IS 17802 checks": ACTIVE_CHECKS.is17802 ? "on" : "off",
    "Media checks": ACTIVE_CHECKS.media ? "on" : "off",
    "PDF / Office audit": ACTIVE_CHECKS.pdfOffice ? "on" : "off",
    "Visual-state checks (links / focus / hover)": ACTIVE_CHECKS.visual ? "on" : "off",
    "Dismiss overlays": ACTIVE_DISMISS ? "on" : "off",
    "Audit both overlay + page": ACTIVE_AUDIT_BOTH ? "on (two passes)" : "off",
    "Screenshots": ACTIVE_SCREENSHOTS ? "on" : "off",
    "Real pages only (links-only discovery)": ACTIVE_LINKS_ONLY ? "on" : "off",
    "Broken-link detector": ACTIVE_LINKCHECK ? "on (status + soft-404 probe + redirect-to-home + rendered-DOM)" : "off",
    "Page settle wait": `adaptive ${SETTLE_MIN_MS / 1000}–${SETTLE_MAX_MS / 1000}s (proceeds after ${SETTLE_QUIET_MS / 1000}s of DOM quiet)`,
    "Concurrency": `${CONCURRENT_TABS} tabs global / ${PER_ORIGIN_TABS} per origin`,
    "Tab load timeout": `${TAB_TIMEOUT_MS / 1000}s`,
    "Worker hard timeout": `${WORKER_HARD_TIMEOUT_MS / 1000}s`
  };
}

// v0.4.4 — link-graph recorder. Maps every harvested internal link target
// to the pages that link to it (+ anchor text), feeding detectBrokenLinks.
function recordLinksInto(linkGraph, sourceUrl, links) {
  if (!linkGraph || !links) return;
  for (const l of links) {
    const u = l && l.url;
    if (!u) continue;
    let e = linkGraph.get(u);
    if (!e) { e = { sources: new Map() }; linkGraph.set(u, e); }
    if (!e.sources.has(sourceUrl) && e.sources.size < 25) {
      e.sources.set(sourceUrl, String(l.text || "").slice(0, 120));
    }
  }
}
function checksFromOptions(options) {
  const c = (options && options.checks) || {};
  return {
    axe: c.axe !== false,
    india: c.india !== false,
    media: c.media === true,
    is17802: c.is17802 !== false,
    pdfOffice: c.pdfOffice === true,
    visual: c.visual === true
  };
}

// v12 fix — in-flight settle tracker. Bug: on sites where multiple
// discovered URLs (e.g. `/about`, `/about-us`, `/about/?ref=nav`,
// `/About/`, old `/company-info` legacy path) all server-redirect to the
// same canonical page (`/about/`), concurrent workers could
// each open a tab on a different queued URL, all land on `/about/` at
// roughly the same moment, and each begin the settle wait. The
// post-sleep `queue.hasSettled(settledUrl)` dedup only kicks in AFTER
// the sleep resolves, so all N tabs sit at `/about/` simultaneously
// for the full settle window (user observation: 8 tabs open on the same
// page). The queue's `seen` set prevents enqueue-time duplication by
// canonical URL, but it can't predict post-redirect identity.
//
// Fix: each worker, immediately after its tab's "complete" event fires
// AND before entering the settle wait, reads the tab's current URL and
// claims a slot in `_inFlightSettleUrls`. If another worker already
// holds the slot (check-and-set is atomic under JS's single-threaded
// model — no await between .has() and .add()) the current worker
// aborts, closes its tab, and skips the scan. The slot is released
// in the finally block regardless of success or failure.
//
// Caveats:
//   • The claim URL is the post-load URL, which may be an intermediate
//     redirect rather than the final settled URL. If a JS redirect
//     fires later, it's caught by the post-sleep settled-URL dedup.
//     So this pass catches only the "server-redirect already complete
//     by waitForTabComplete" case, not the rarer "still mid-JS-redirect
//     when complete fires" case. The existing post-sleep dedup
//     continues to handle that.
//   • Normalization: claim URLs pass through canonicalize() so
//     trailing-slash / tracking-param variants dedup against the same
//     slot (without this, 2 tabs both on /about/?tracking=X vs
//     /about/?tracking=Y would both claim distinct slots).
const _inFlightSettleUrls = new Set();

const pending = new Map();
const reports = new Map();
const inventories = new Map(); // inventoryId → { inventory, files: { docx: Blob, xlsx: Blob } }
// Full-page screenshots live here, keyed by a per-screenshot id. Kept OUT of
// the inventory payload because a single inventory with 500 pages × ~500KB
// PNGs would blow past chrome.runtime.sendMessage's practical payload ceiling
// (~32-64MB). The inventory stores only {id, bytes} references; the viewer
// fetches each image on demand via the GET_SCREENSHOT message.
const inventoryScreenshots = new Map(); // screenshotId → { dataUrl, bytes }
const rateLimiter = new RateLimiter({ perOriginMax: PER_ORIGIN_TABS });

// v0.4.8 — reports survive service-worker eviction. MV3 kills an idle
// service worker after ~30s; anything held only in the in-memory `reports`
// Map is gone after that, so refreshing the report tab or clicking Download
// later returned "Report expired". Reports are now persisted to
// chrome.storage.local (like inventories already were) and re-warmed into
// memory on demand. The last 5 reports are kept; older ones are pruned so
// storage doesn't grow without bound.
const REPORT_KEEP = 5;
async function persistReport(reportId, report) {
  try {
    await chrome.storage.local.set({ [`report:${reportId}`]: report });
    const got = await chrome.storage.local.get("report-ids");
    const ids = Array.isArray(got?.["report-ids"]) ? got["report-ids"] : [];
    ids.push(reportId);
    const drop = ids.splice(0, Math.max(0, ids.length - REPORT_KEEP));
    await chrome.storage.local.set({ "report-ids": ids });
    if (drop.length) await chrome.storage.local.remove(drop.map(id => `report:${id}`));
  } catch (err) {
    console.warn("[EU] persistReport failed — report will only survive while the service worker lives", err?.message || err);
  }
}
async function getReport(reportId) {
  const mem = reports.get(reportId);
  if (mem) return mem;
  try {
    const got = await chrome.storage.local.get(`report:${reportId}`);
    const rep = got?.[`report:${reportId}`] || null;
    if (rep) reports.set(reportId, rep); // re-warm for subsequent downloads
    return rep;
  } catch { return null; }
}

// Enforce a non-zero floor on numeric options without imposing a ceiling.
function floorInt(raw, fallback, floor = 1) {
  const n = parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.max(floor, n);
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  (async () => {
    try {
      if (msg.type === "SCAN_CURRENT") sendResponse(await scanCurrent(msg.tabId, msg.options));
      // v0.4.8 — SCAN_MULTI now runs the same full-audit crawl pipeline as
      // inventory mode and presents in the tabbed viewer (Findings /
      // Screenshots / Templates). The classic flat report stays reachable
      // from the viewer via OPEN_CLASSIC_REPORT below.
      else if (msg.type === "SCAN_MULTI") sendResponse(await scanInventory(msg.tabId, msg.options));
      else if (msg.type === "SCAN_INVENTORY") sendResponse(await scanInventory(msg.tabId, msg.options));
      else if (msg.type === "OPEN_CLASSIC_REPORT") sendResponse(await openClassicReport(msg.inventoryId));
      else if (msg.type === "SCAN_LIST") sendResponse(await scanList(msg.options));
      else if (msg.type === "RECOVER_CHECKPOINT") sendResponse(await recoverCheckpoint());
      else if (msg.type === "SCAN_RESULT") sendResponse(handleResult(msg.payload, sender));
      else if (msg.type === "SCAN_ERROR") sendResponse(handleError(msg.payload, sender));
      else if (msg.type === "GET_REPORT") sendResponse({ ok: true, report: await getReport(msg.reportId) });
      else if (msg.type === "GET_INVENTORY") sendResponse(await getInventory(msg.inventoryId));
      else if (msg.type === "GET_SCREENSHOT") sendResponse(await getScreenshot(msg.id));
      else if (msg.type === "DOWNLOAD_CSV") sendResponse(await downloadCsv(msg.reportId));
      else if (msg.type === "DOWNLOAD_REPORT_XLSX") sendResponse(await downloadReportXlsx(msg.reportId));
      else if (msg.type === "DOWNLOAD_SCOPE_DOCX") sendResponse(await downloadInventoryFile(msg.inventoryId, "docx"));
      else if (msg.type === "DOWNLOAD_INVENTORY_XLSX") sendResponse(await downloadInventoryFile(msg.inventoryId, "xlsx"));
      else if (msg.type === "DOWNLOAD_CLUSTERS_XLSX") sendResponse(await downloadInventoryFile(msg.inventoryId, "clusters"));
      else if (msg.type === "DOWNLOAD_AUDIT_XLSX") sendResponse(await downloadInventoryFile(msg.inventoryId, "audit"));
      else sendResponse({ ok: false, error: "unknown message" });
    } catch (err) {
      console.error("[EU]", err);
      sendResponse({ ok: false, error: String(err?.message || err) });
    }
  })();
  return true;
});

// GET_INVENTORY / GET_SCREENSHOT both hit the in-memory Map first, then fall
// back to chrome.storage.local. This is what survives MV3 service-worker
// eviction: the worker may have been restarted since the crawl completed, in
// which case our Maps are empty but storage.local still has the data.
async function getInventory(inventoryId) {
  let inventory = inventories.get(inventoryId)?.inventory || null;
  if (!inventory) {
    try {
      const key = `inv:${inventoryId}`;
      const stored = await chrome.storage.local.get(key);
      inventory = stored[key] || null;
    } catch (err) {
      console.warn("[EU] getInventory storage fallback failed", err);
    }
  }
  return { ok: true, inventory };
}

async function getScreenshot(id) {
  if (!id) return { ok: false, dataUrl: null };
  let entry = inventoryScreenshots.get(id) || null;
  if (!entry) {
    try {
      const key = `shot:${id}`;
      const stored = await chrome.storage.local.get(key);
      entry = stored[key] || null;
    } catch (err) {
      console.warn("[EU] getScreenshot storage fallback failed", err);
    }
  }
  return { ok: !!entry, dataUrl: entry?.dataUrl || null };
}

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
  const profile = (options?.profile && PROFILES[options.profile]) ? options.profile : "wcag21aa";
  ACTIVE_AXE_TAGS = tagsForProfile(profile);
  ACTIVE_CHECKS = checksFromOptions(options);
  ACTIVE_DISMISS = !!(options && options.dismissOverlays);
  ACTIVE_AUDIT_BOTH = !!(options && options.auditBoth);
  const result = await scanInExistingTab(tabId);
  const report = buildReport([{ url: tab.url, title: tab.title, ...result }], { mode: "single", seedUrl: tab.url, profile });
  const reportId = `r-${Date.now()}`;
  reports.set(reportId, report);
  await persistReport(reportId, report); // v0.4.8 — survive SW eviction
  await chrome.tabs.create({ url: chrome.runtime.getURL(`report/report.html?id=${reportId}`) });
  return { ok: true, reportId };
}

// v0.4.8 — scanMulti removed. SCAN_MULTI now routes to scanInventory (same
// discovery + crawl engine, plus template fingerprints, content signals,
// screenshots, and checkpoint/recovery). The classic flat report this
// function used to build is still available on demand — see
// openClassicReport(), which adapts a stored inventory back into
// buildReport's page shape.

// Rebuild the classic report.html presentation (WCAG criterion status,
// conformance by standard, media & documents, passes/incomplete/inapplicable
// tables, scan environment, CSV/Excel/JSON exports) from a completed
// inventory crawl. The inventory page records carry the FULL axe payload
// (see inventoryInNewTab), so nothing needs rescanning — this is a pure
// reshape: flatten each page's nested `audit` back to the top level that
// buildReport expects.
function inventoryPagesToReportPages(inventory) {
  const all = [
    ...(inventory.pages || []),
    ...(inventory.shellPages || []),
    ...(inventory.hashDuplicates || [])
  ];
  return all.map(p => ({
    url: p.url,
    title: p.title || "",
    depth: p.depth ?? "",
    source: p.source || "",
    ...(p.error ? { error: p.error } : {}),
    ...(p.audit || {}),
    mediaInventory: p.mediaInventory || null
  }));
}

async function openClassicReport(inventoryId) {
  let inventory = inventories.get(inventoryId)?.inventory || null;
  if (!inventory) {
    try {
      const stored = await chrome.storage.local.get(`inv:${inventoryId}`);
      inventory = stored[`inv:${inventoryId}`] || null;
    } catch (err) {
      console.warn("[EU] openClassicReport storage fallback failed", err);
    }
  }
  if (!inventory) return { ok: false, error: "Inventory expired" };

  const meta = inventory.meta || {};
  const report = buildReport(inventoryPagesToReportPages(inventory), {
    mode: meta.mode || "multi",
    seedUrl: meta.seedUrl || "",
    maxUrls: meta.maxUrls,
    crawlDepth: meta.crawlDepth,
    depthStats: meta.depthStats || {},
    ...(meta.discoveryStats ? { discoveryStats: meta.discoveryStats } : {}),
    profile: meta.profile,
    stopReason: meta.stopReason || "completed"
  });
  // Prefer the inventory's media rows when present — they carry the PDF /
  // Office structural-audit enrichment (pdfAudit / officeAudit) that
  // buildReport's fresh collection wouldn't have.
  if (Array.isArray(inventory.mediaRows) && inventory.mediaRows.length) {
    report.mediaRows = inventory.mediaRows;
    if (inventory.mediaSummary) report.mediaSummary = inventory.mediaSummary;
  }
  report.brokenLinks = inventory.brokenLinks || null;
  report.settings = inventory.settings || null;

  const reportId = `r-${Date.now()}`;
  reports.set(reportId, report);
  await persistReport(reportId, report);
  await chrome.tabs.create({ url: chrome.runtime.getURL(`report/report.html?id=${reportId}`) });
  return { ok: true, reportId };
}

// ─────────────────────────────────────────────────────────────────────────
// Full-audit crawl — the single crawl engine behind BOTH the popup's
// "Multi Page Scan" and "Inventory / Scope Mode" buttons (v0.4.8). Every
// page gets the full audit stack (axe + india + is17802 + media + visual)
// plus template fingerprint, content signals, and optional screenshots.
// Results open in the tabbed viewer (report/inventory.html); the classic
// flat report remains available from there via openClassicReport().
// ─────────────────────────────────────────────────────────────────────────
async function scanInventory(tabId, options) {
  // Inventory mode: no ceilings on maxUrls or depth. The operator decides.
  const maxUrls = floorInt(options?.maxUrls, DEFAULT_MAX_URLS, 1);
  // Inventory mode has NO depth cap. The only real crawl bound is maxUrls —
  // the priority queue biases shallow pages first, so unbounded depth just
  // means "keep expanding until maxUrls is reached or the frontier is empty".
  // A user-supplied crawlDepth > 0 is still honoured exactly (no upper clamp),
  // for operators who want to short-circuit a deep site deliberately.
  const rawDepth = parseInt(options?.crawlDepth, 10);
  const crawlDepth = (Number.isFinite(rawDepth) && rawDepth > 0)
    ? rawDepth
    : Number.POSITIVE_INFINITY;

  const tab = await chrome.tabs.get(tabId);
  const startUrl = tab.url;
  const seedOrigin = safeOrigin(startUrl);
  const seedHost = safeHost(startUrl);

  const queue = new RequestQueue({ scopeUrl: startUrl, maxUrls, maxDepth: crawlDepth, scope: "same-hostname" });
  queue.enqueue(startUrl, { depth: 0, priority: 100, source: "seed" });
  // Mark the seed's URL as settled so workers dedup against it.
  queue.markSettled(startUrl);

  // Resolve the compliance profile up front so the WCAG tag set is active
  // BEFORE the seed scan runs (it was previously resolved only after the
  // crawl, so every page scanned with the default 2.1 tags regardless of the
  // operator's selection). ACTIVE_AXE_TAGS drives content-script.js.
  const profile = (options?.profile && PROFILES[options.profile]) ? options.profile : "wcag21aa";
  ACTIVE_AXE_TAGS = tagsForProfile(profile);
  ACTIVE_CHECKS = checksFromOptions(options);
  ACTIVE_DISMISS = !!(options && options.dismissOverlays);
  ACTIVE_AUDIT_BOTH = !!(options && options.auditBoth);
  ACTIVE_SCREENSHOTS = !!(options && options.screenshots);
  ACTIVE_LINKS_ONLY = !!(options && options.linksOnly);
  ACTIVE_LINKCHECK = !(options && options.brokenLinks === false);
  const linkGraph = ACTIVE_LINKCHECK ? new Map() : null;

  console.log(`[EU] inventory scan start — seed=${startUrl} maxUrls=${maxUrls} depth=${crawlDepth} profile=${profile} tags=${ACTIVE_AXE_TAGS.join(",")} screenshots=${ACTIVE_SCREENSHOTS} linksOnly=${ACTIVE_LINKS_ONLY}`);

  // Reset live-progress state. Written to chrome.storage.local so the popup
  // can show it even if the popup was closed while the scan ran. Updated
  // after every tab finishes. Cleared with { active:false } when scanInventory
  // returns. See progressUpdate() below.
  await chrome.storage.local.set({
    "scan-progress": {
      mode: "inventory",
      active: true,
      done: 0,
      total: Number.isFinite(maxUrls) ? maxUrls : 0,
      currentUrl: startUrl,
      startedAt: Date.now(),
      seedUrl: startUrl
    }
  }).catch(() => {});
  async function progressUpdate(patch) {
    try {
      const got = await chrome.storage.local.get("scan-progress");
      const prev = got?.["scan-progress"] || {};
      await chrome.storage.local.set({ "scan-progress": { ...prev, ...patch } });
    } catch {}
  }

  const pages = [];
  const depthStats = {};

  // v0.2.6 — Shared content-hash dedup map for inventory workers. Key =
  // text_hash (the rendered-text hash computed during the content scan).
  // Value = the FIRST URL that produced that hash. When a subsequent
  // worker gets the same hash back from runContentScan, we skip the
  // full-page screenshot (the biggest skippable per-page cost after axe)
  // and tag the page record with `duplicate_of` so buildInventory
  // collapses it into the primary page rather than emitting it as a
  // distinct row. This catches same-content-different-slug collisions
  // that the slug-based cross-folder dedup in buildInventory can't see
  // (e.g. /devang-patel vs /pallavi-deshpande both rendering identical
  // bio-page content). The seed's hash is populated below once the seed
  // audit completes.
  const seenTextHashes = new Map();

  // Seed page runs the SAME full audit stack as every other crawled URL —
  // axe + india + is17802 + media + content-signals + full-page screenshot. Runs in the
  // existing tab (no new tab open) so the user's session/cookies/scroll
  // state is preserved for the seed.
  queue.next();
  depthStats[0] = 1;
  try {
    await injectAxe(tabId);
    const auditPayload = await runContentScan(tabId);
    const signals = await collectContentSignals(tabId);
    let screenshot = null;
    // Seed runs in the user's VISIBLE tab — element capture scrolls each
    // element into view, which would jar the page (the codebase deliberately
    // avoids scrolling the seed). So the seed gets a full-page shot only;
    // element screenshots are captured on the hidden worker tabs.
    // v0.4.3 — skipped entirely unless the operator opted into screenshots.
    if (ACTIVE_SCREENSHOTS) {
      try { screenshot = await captureFullPageScreenshot(tabId); }
      catch (err) { console.warn(`[EU] seed screenshot failed:`, err?.message || err); }
    }
    const tmpl = auditPayload?.template || {};
    // content-signals.js returns `url: location.href` AND `canonicalUrl`
    // (from <link rel="canonical">) — strip both out before spreading so
    // they can't override the top-level fields. finalUrl keeps the settled
    // URL (post client-side redirect/trailing slash normalisation);
    // canonicalUrl is the site's self-declared authoritative URL for this
    // page. Both feed into the user-journey dedup key in buildInventory.
    const { url: seedFinalUrl, canonicalUrl: seedCanonical, ...seedSignals } = signals || {};
    // If the seed tab redirected during scan (e.g. the user clicked the
    // extension before a JS-based disclosure gate fired), seedFinalUrl is
    // the post-redirect URL. Mark it so workers dedup against it.
    if (seedFinalUrl) queue.markSettled(seedFinalUrl);
    pages.push({
      url: startUrl,
      finalUrl: seedFinalUrl || startUrl,
      canonicalUrl: seedCanonical || "",
      title: auditPayload?.title || tab.title || "", depth: 0, source: "seed",
      template_id: tmpl.fingerprint || "unknown",
      url_cluster: tmpl.urlCluster || "unknown",
      text_hash: tmpl.textHash || "",
      // v0.4.0 team-merge — DOM simhash + top-level tag preview. Captured
      // alongside the SiteScope-style fingerprint so the inventory UI can
      // offer BOTH exact-match template grouping AND Hamming-distance
      // near-dup clustering.
      dom_hash: tmpl.domHash || "",
      dom_preview: tmpl.domPreview || "",
      element_counts: tmpl.elementCounts || {},
      audit: {
        scanStartedAt: auditPayload?.scanStartedAt || null,
        scanDurationMs: auditPayload?.scanDurationMs || 0,
        testEngine: auditPayload?.testEngine || null,
        testRunner: auditPayload?.testRunner || null,
        testEnvironment: auditPayload?.testEnvironment || null,
        toolOptions: auditPayload?.toolOptions || null,
        axeTimestamp: auditPayload?.axeTimestamp || null,
        axeUrl: auditPayload?.axeUrl || null,
        violations: auditPayload?.violations || [],
        passes: auditPayload?.passes || [],
        incomplete: auditPayload?.incomplete || [],
        inapplicable: auditPayload?.inapplicable || []
      },
      // v0.4.8 — media & document inventory (videos / audio / embedded
      // players / linked PDFs & Office docs) was previously dropped on the
      // inventory path, which left buildInventory without mediaRows and made
      // the PDF / Office structural audits a silent no-op. Kept per page so
      // collectMediaRows can build the corpus-level media table.
      mediaInventory: auditPayload?.mediaInventory || null,
      screenshot,
      ...seedSignals
    });
    // v0.2.6 — Seed the hash-dedup map so any subsequently-crawled URL
    // that renders identical text content (classic SPA-shell / soft-404
    // signature, or a same-content-different-slug alias) is recognised
    // as a duplicate and spared the screenshot pass.
    if (tmpl.textHash) seenTextHashes.set(tmpl.textHash, startUrl);
  } catch (err) {
    pages.push({ url: startUrl, depth: 0, source: "seed", error: String(err?.message || err) });
  }
  // Seed page is done — tick progress. "done" counts every finished URL
  // whether the fetch succeeded or errored, because the operator cares about
  // completion state, not just successes.
  await progressUpdate({ done: pages.length, currentUrl: startUrl });

  // Discovery — seedDiscovery() runs sitemap,
  // homepage <link rel=…>, RSS/Atom feeds, and in-page nav harvest in
  // parallel and enqueues them in priority order (nav > canonical/next/prev
  // > hreflang > feed > sitemap > body) so limited-budget crawls don't get
  // starved by a 10k-entry sitemap dumped first.
  await openCrawlerWindow();
  // v0.4.4 — render the site's not-found page (worker tab on a nonexistent
  // URL) in parallel with discovery, so the rendered-DOM soft-404 layer has
  // its baseline before any worker scans a page.
  // v0.4.8 — discoveryStats kept (previously discarded) so the meta reaches
  // buildInventory and the classic-report bridge can echo discovery counts.
  const discoveryStats = { nav: 0, body: 0, sitemap: 0, hreflang: 0, feed: 0, linkRels: 0, sitemapRaw: 0, feedRaw: 0 };
  const [, r404] = await Promise.all([
    seedDiscovery({
      tabId, startUrl, seedOrigin, queue, depth: 1,
      discoveryStats,
      linksOnly: ACTIVE_LINKS_ONLY,
      onLinks: linkGraph ? (src, links) => recordLinksInto(linkGraph, src, links) : null
    }),
    ACTIVE_LINKCHECK ? probeRendered404(seedOrigin) : Promise.resolve(null)
  ]);
  ACTIVE_R404 = r404;

  console.log(`[EU] post-discovery queue size: ${queue.pending} pending, ${queue.total} total seen`);

  const active = new Set();
  let errorStreak = 0;
  let stopReason = null;
  // v0.4.3 — checkpoint meta reused on every periodic write.
  const checkpointMeta = { mode: "inventory", seedUrl: startUrl, seedHost, maxUrls, crawlDepth, profile, depthStats, startedAt: Date.now() };

  async function launch(req) {
    console.log(`[EU] launch: ${req.url} (source=${req.source}, depth=${req.depth})`);
    // See comment on the audit-mode launch above for why `acquired` is
    // tracked and why release() lives in a finally block. Short version:
    // semaphore slots MUST be freed on every exit path or the origin stalls.
    let acquired = false;
    try {
      const token = await rateLimiter.wait(req.url);
      acquired = token != null;
      // v12.2 — hard ceiling so one stuck tab can't stall the whole pool.
      const result = await withTimeout(
        inventoryInNewTab(req.url, req.depth < crawlDepth, { queue, seenTextHashes }),
        WORKER_HARD_TIMEOUT_MS,
        `worker ${req.url}`
      );
      rateLimiter.reportSuccess(req.url);

      // Settled-URL dedup: the tab landed on a URL another worker already
      // scanned (typical of disclosure-gate sites). Record a minimal page
      // entry noting the redirect and skip further work — no axe run, no
      // link harvesting, no next-depth enqueue.
      if (result.__skipped === "redirect-to-duplicate") {
        pages.push({
          url: req.url,
          finalUrl: result.settledUrl || req.url,
          depth: req.depth, source: req.source,
          title: result.title || "",
          error: `redirected to already-scanned URL: ${result.settledUrl}`
        });
        depthStats[req.depth] = (depthStats[req.depth] || 0) + 1;
        errorStreak = 0; // a clean dedup skip is not a failure
        return;
      }

      // Strip `url` AND `canonicalUrl` out of result before spreading.
      // inventoryInNewTab -> collectContentSignals returns `url: location.href`
      // (which, if spread, would overwrite our canonical req.url and cause
      // two enqueues — e.g. /foo?from=a vs /foo?from=b, both SPAs strip to
      // /foo on settle — to end up as two rows with identical p.url) and
      // `canonicalUrl` (the <link rel="canonical"> value, used as the top-
      // priority dedup key in buildInventory). Keep the post-settle URL as
      // finalUrl for the audit trail.
      const { links = [], url: finalUrl, canonicalUrl, ...rest } = result;
      pages.push({
        url: req.url,
        finalUrl: finalUrl || req.url,
        canonicalUrl: canonicalUrl || "",
        depth: req.depth, source: req.source,
        ...rest
      });
      depthStats[req.depth] = (depthStats[req.depth] || 0) + 1;
      errorStreak = 0;
      if (linkGraph && links.length) recordLinksInto(linkGraph, req.url, links);
      if (req.depth < crawlDepth) {
        const nav = links.filter(l => l.priority >= 10).map(l => l.url);
        const body = links.filter(l => l.priority < 10).map(l => l.url);
        queue.enqueueMany(nav, { depth: req.depth + 1, priority: 8, source: "nav" });
        queue.enqueueMany(body, { depth: req.depth + 1, priority: 2, source: "body" });
      }
    } catch (err) {
      rateLimiter.reportFailure(req.url, { status: err?.status || 0 });
      pages.push({ url: req.url, depth: req.depth, source: req.source, error: String(err?.message || err) });
      errorStreak++;
    } finally {
      if (acquired) rateLimiter.release(req.url);
    }
    // Progress tick after every launched URL (success or error). Don't
    // await — fire-and-forget so a slow chrome.storage write can't block
    // the next tab from launching. Popup polls via storage.onChanged.
    progressUpdate({ done: pages.length, currentUrl: req.url });
    // v0.4.3 — periodic checkpoint (fire-and-forget) so a crash mid-crawl
    // leaves a recoverable partial result.
    if (pages.length % CHECKPOINT_EVERY === 0) checkpointCrawl(pages, checkpointMeta);
  }

  function pump() {
    // v0.4.3 circuit breaker — stop launching once the error streak trips;
    // in-flight workers drain naturally and the meta records the trip.
    if (errorStreak >= ERROR_STREAK_LIMIT) {
      if (!stopReason) {
        stopReason = `stopped early: ${errorStreak} consecutive page failures`;
        console.warn(`[EU] circuit breaker tripped — ${stopReason}`);
      }
      return;
    }
    while (active.size < CONCURRENT_TABS && queue.pending && queue.remaining > 0) {
      const req = queue.next();
      if (!req) break;
      const p = launch(req).finally(() => active.delete(p));
      active.add(p);
    }
  }
  pump();
  while (active.size > 0) { await Promise.race(active); pump(); }
  await closeCrawlerWindow();

  // v0.4.4 — status-check every internal link target found during the crawl.
  // Runs while the progress banner is still active so the operator sees it.
  let brokenLinks = null;
  if (linkGraph && linkGraph.size) {
    console.log(`[EU] broken-link check — ${linkGraph.size} unique internal link target(s)`);
    await progressUpdate({ currentUrl: `checking ${Math.min(linkGraph.size, 8000)} internal links for 404s…` });
    try {
      brokenLinks = await detectBrokenLinks({
        linkGraph, origin: seedOrigin,
        onProgress: (done, total) => progressUpdate({ currentUrl: `link check ${done}/${total}` })
      });
      console.log(`[EU] broken-link check done — ${brokenLinks.brokenCount} broken of ${brokenLinks.checked} checked (not-found mode: ${brokenLinks.notFoundMode})`);
    } catch (err) {
      console.warn("[EU] broken-link check failed:", err?.message || err);
    }
  }
  // Fold in the rendered-DOM soft-404 verdicts collected per crawled page.
  brokenLinks = mergeRenderedVerdicts(brokenLinks, pages, linkGraph);
  ACTIVE_R404 = null;

  // Mark the crawl as inactive so the popup's progress banner disappears.
  // Keep the final done/total for one refresh so the user sees "done" before
  // it clears.
  await progressUpdate({ active: false, currentUrl: "", completedAt: Date.now(), done: pages.length });

  const inventory = buildInventory(pages, { seedUrl: startUrl, seedHost, maxUrls, crawlDepth, depthStats, discoveryStats, profile, stopReason: stopReason || "completed" });
  inventory.brokenLinks = brokenLinks;
  // v0.4.8 — one crawl engine serves both popup buttons, so the echoed mode
  // label covers both.
  inventory.settings = settingsEcho("full-audit crawl (multi-page / scope)", { profile, maxUrls, crawlDepth });

  // v13.1 — audit every discovered PDF for structural accessibility
  // markers (tagged, struct tree, /Lang, /Title). Enriches the PDF rows
  // in mediaRows with an `pdfAudit` object and appends ruleset findings
  // so the report renders them alongside media-checks.js findings.
  if (ACTIVE_CHECKS.pdfOffice) await enrichPdfRowsWithAudit(inventory);

  // v0.2.2 — same treatment for Office documents. Byte-level zip read of
  // each docx/xlsx/pptx, extract dc:title / dc:language, verify at least
  // one heading paragraph style (docx) / sheet (xlsx) / slide (pptx).
  if (ACTIVE_CHECKS.pdfOffice) await enrichOfficeRowsWithAudit(inventory);

  const inventoryId = `inv-${Date.now()}`;

  // Store the inventory in memory with EMPTY deliverable slots. The .docx /
  // .xlsx blobs are generated lazily on first download click (see
  // downloadInventoryFile, which already has the regenerate-from-inventory
  // fallback path from the Risk-2 fix). This is deliberate:
  //
  //   • On large crawls (hundreds of pages), OOXML generation can take
  //     10-30s. Blocking the viewer tab behind that is user-hostile — the
  //     HTML report is ready to paint the instant crawling finishes.
  //   • If blob generation throws (OOM, deep recursion, whatever), we still
  //     have a working viewer. Previously an exception here killed the whole
  //     handler and the report never opened.
  //   • MV3 service-worker eviction during the 10-30s blob-generation window
  //     was another silent failure mode — the SW could die after the crawl
  //     completed but before chrome.tabs.create ran. Opening the tab first
  //     closes that race.
  inventories.set(inventoryId, { inventory, files: {} });

  // Persist inventory + screenshots to chrome.storage.local BEFORE opening
  // the viewer tab. Awaited (not fire-and-forget) so that if the service
  // worker is evicted the instant after tab.create, the viewer can still
  // recover the data via the storage fallback in getInventory /
  // getScreenshot. The "unlimitedStorage" permission lifts the 10MB default
  // cap so large crawls don't hit the quota ceiling.
  try {
    await persistInventory(inventoryId, inventory);
  } catch (err) {
    console.warn("[EU] persistInventory failed — continuing without persistence", err);
  }

  // Open the viewer immediately. Even if chrome.tabs.create somehow fails,
  // we still return the inventoryId so a caller (or the popup) could retry.
  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`report/inventory.html?id=${inventoryId}`) });
  } catch (err) {
    console.warn("[EU] failed to open inventory tab", err);
  }
  // v0.4.3 — crawl finished and the inventory is persisted; the mid-crawl
  // checkpoint is now superseded.
  clearCheckpoint();
  return { ok: true, inventoryId };
}

// Fire-and-forget persistence. One chrome.storage.local.set call containing
// the inventory payload + every screenshot it references.
async function persistInventory(inventoryId, inventory) {
  const record = { [`inv:${inventoryId}`]: inventory };
  const seen = new Set();
  const collectById = (id) => {
    if (!id || seen.has(id)) return;
    const entry = inventoryScreenshots.get(id);
    if (entry) {
      record[`shot:${id}`] = entry;
      seen.add(id);
    }
  };
  const collect = (shot) => collectById(shot?.id);
  // v0.4.2 — also persist the issue-specific element screenshots referenced by
  // violation nodes (node.elementShotId), so they survive service-worker
  // eviction and the viewer / Excel thumbnailer can resolve them via the
  // storage fallback just like full-page screenshots.
  const collectShotsFromAudit = (audit) => {
    for (const v of (audit?.violations || [])) {
      for (const n of (v.nodes || [])) collectById(n.elementShotId);
    }
  };
  for (const p of inventory.pages || []) { collect(p.screenshot); collectShotsFromAudit(p.audit); }
  for (const t of inventory.templates || []) { collect(t.sample_screenshot); collectShotsFromAudit(t.sample_audit); }
  await chrome.storage.local.set(record);
  console.log(`[EU] persisted inventory ${inventoryId} + ${seen.size} screenshot(s) to storage.local`);
}

// ─────────────────────────────────────────────────────────────────────────
// Template-check mode — the operator pastes a list of URLs. We skip ALL
// discovery (no sitemap, no nav harvest, no link following), skip the
// BLOCKED_PATH_PREFIXES filter (the operator pasted these URLs deliberately),
// skip the settled-URL dedup (every pasted URL is its own row), and run the
// full audit + content-signals + screenshot on each. The inventory is
// rendered with noDedup:true so every pasted URL shows up as its own row in
// the all-pages view. Template clustering is still computed and surfaced in
// the Templates section so the operator can see which pasted URLs share a
// shell — the clustering answer is the whole point of this mode.
//
// Per-origin concurrency cap (PER_ORIGIN_TABS) still applies: pasting 200
// URLs from a single host won't slam the server — only 8 tabs per origin
// are in-flight at once.
// ─────────────────────────────────────────────────────────────────────────
async function scanList(options) {
  // Parse the pasted text into a URL array. We accept either a pre-split
  // array (msg.options.urls) or a raw blob (msg.options.text) that the
  // popup didn't bother parsing. Normalization:
  //   - trim each line
  //   - drop empty lines and lines starting with "#" (comments)
  //   - accept anything `new URL(x)` will parse; reject the rest as
  //     error rows so the operator sees their typo instead of silently
  //     dropping the entry.
  let rawLines;
  if (Array.isArray(options?.urls)) {
    rawLines = options.urls;
  } else {
    rawLines = String(options?.text || "").split(/\r?\n/);
  }
  const profile = (options?.profile && PROFILES[options.profile]) ? options.profile : "wcag21aa";
  ACTIVE_AXE_TAGS = tagsForProfile(profile);
  ACTIVE_CHECKS = checksFromOptions(options);
  ACTIVE_DISMISS = !!(options && options.dismissOverlays);
  ACTIVE_AUDIT_BOTH = !!(options && options.auditBoth);
  ACTIVE_SCREENSHOTS = !!(options && options.screenshots);
  // v0.4.4 — pasted lists get the rendered-DOM wording heuristic (no
  // baseline probe — the list may span many origins).
  ACTIVE_LINKCHECK = !(options && options.brokenLinks === false);
  ACTIVE_R404 = null;

  const parsed = [];
  const seenExact = new Set();
  const invalidRows = []; // {url, error} records emitted straight to pages
  for (const raw of rawLines) {
    const s = String(raw || "").trim();
    if (!s) continue;
    if (s.startsWith("#")) continue;
    // Try as-is. If that fails, try prepending https://.
    let parsedUrl = null;
    try { parsedUrl = new URL(s); } catch {}
    if (!parsedUrl && !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      try { parsedUrl = new URL(`https://${s}`); } catch {}
    }
    if (!parsedUrl) {
      invalidRows.push({ url: s, error: "invalid URL — could not parse" });
      continue;
    }
    const href = parsedUrl.href;
    // Exact-string dedup only. If the operator pasted the same URL twice,
    // that's almost always a typo; one row is less confusing than two.
    // We do NOT canonicalize or normalize beyond parse-and-stringify.
    if (seenExact.has(href)) continue;
    seenExact.add(href);
    parsed.push(href);
  }

  if (parsed.length === 0 && invalidRows.length === 0) {
    return { ok: false, error: "no URLs provided" };
  }

  const seedUrl = parsed[0] || "about:blank";
  const seedHost = safeHost(seedUrl);

  console.log(`[EU] template-check start — ${parsed.length} URLs (+ ${invalidRows.length} invalid)`);

  // Reset progress state so the popup banner renders.
  await chrome.storage.local.set({
    "scan-progress": {
      mode: "template-check",
      active: true,
      done: 0,
      total: parsed.length,
      currentUrl: seedUrl,
      startedAt: Date.now(),
      seedUrl
    }
  }).catch(() => {});
  async function progressUpdate(patch) {
    try {
      const got = await chrome.storage.local.get("scan-progress");
      const prev = got?.["scan-progress"] || {};
      await chrome.storage.local.set({ "scan-progress": { ...prev, ...patch } });
    } catch {}
  }

  const pages = [];
  // Emit invalid URLs as error rows up front so the operator sees exactly
  // which of their pasted lines failed parsing.
  for (const ir of invalidRows) {
    pages.push({ url: ir.url, depth: 0, source: "pasted", error: ir.error });
  }

  const active = new Set();
  const toScan = parsed.slice(); // FIFO; preserves paste order
  let errorStreak = 0;
  let stopReason = null;
  await openCrawlerWindow();

  async function launch(url) {
    console.log(`[EU] template-check launch: ${url}`);
    let acquired = false;
    try {
      const token = await rateLimiter.wait(url);
      acquired = token != null;
      // queue=null disables the settled-URL dedup branch in inventoryInNewTab.
      // collectNextLinks=false because we are not following links in this mode.
      const result = await inventoryInNewTab(url, false, { queue: null });
      rateLimiter.reportSuccess(url);

      const { links: _links, url: finalUrl, canonicalUrl, ...rest } = result || {};
      pages.push({
        url,
        finalUrl: finalUrl || url,
        canonicalUrl: canonicalUrl || "",
        depth: 0, source: "pasted",
        ...rest
      });
      errorStreak = 0;
    } catch (err) {
      rateLimiter.reportFailure(url, { status: err?.status || 0 });
      console.warn(`[EU] template-check failed: ${url}`, err?.message || err);
      pages.push({ url, depth: 0, source: "pasted", error: String(err?.message || err) });
      errorStreak++;
    } finally {
      if (acquired) rateLimiter.release(url);
    }
    progressUpdate({ done: pages.length, currentUrl: url });
  }

  function pump() {
    // v0.4.3 circuit breaker — emit the unscanned remainder as explicit
    // rows so the operator sees exactly which pasted URLs were skipped.
    if (errorStreak >= ERROR_STREAK_LIMIT) {
      if (!stopReason) {
        stopReason = `stopped early: ${errorStreak} consecutive page failures`;
        console.warn(`[EU] circuit breaker tripped — ${stopReason}`);
        while (toScan.length > 0) {
          pages.push({ url: toScan.shift(), depth: 0, source: "pasted", error: "skipped — circuit breaker tripped (too many consecutive failures)" });
        }
      }
      return;
    }
    while (active.size < CONCURRENT_TABS && toScan.length > 0) {
      const url = toScan.shift();
      const p = launch(url).finally(() => active.delete(p));
      active.add(p);
    }
  }
  pump();
  while (active.size > 0) { await Promise.race(active); pump(); }
  await closeCrawlerWindow();

  await progressUpdate({ active: false, currentUrl: "", completedAt: Date.now(), done: pages.length });

  // Build the inventory with noDedup:true so every pasted URL renders as its
  // own row. Template clustering is still computed the same way — the
  // Templates section will group these rows by template_id so the operator
  // can see which pasted URLs share a shell (uniform) vs. span multiple
  // templates (varied).
  const inventory = buildInventory(pages, {
    seedUrl,
    seedHost,
    maxUrls: parsed.length,
    crawlDepth: 0,
    depthStats: { 0: pages.length },
    profile,
    mode: "template-check",
    noDedup: true,
    stopReason: stopReason || "completed"
  });
  // v0.4.4 — rendered-DOM soft-404 verdicts for pasted URLs.
  inventory.brokenLinks = mergeRenderedVerdicts(null, pages, null);
  inventory.settings = settingsEcho("template check (pasted list)", { profile, maxUrls: parsed.length, crawlDepth: 0 });

  // v13.1 PDF audit for the pasted URL list path too — every PDF linked
  // from any pasted page gets inspected.
  if (ACTIVE_CHECKS.pdfOffice) await enrichPdfRowsWithAudit(inventory);

  // v0.2.2 Office audit for the pasted URL list path as well.
  if (ACTIVE_CHECKS.pdfOffice) await enrichOfficeRowsWithAudit(inventory);

  const inventoryId = `inv-${Date.now()}`;
  inventories.set(inventoryId, { inventory, files: {} });

  try { await persistInventory(inventoryId, inventory); }
  catch (err) { console.warn("[EU] persistInventory failed", err); }

  try {
    await chrome.tabs.create({ url: chrome.runtime.getURL(`report/inventory.html?id=${inventoryId}`) });
  } catch (err) {
    console.warn("[EU] failed to open inventory tab", err);
  }
  return { ok: true, inventoryId, scanned: pages.length };
}

// Inventory mode per-page worker. Runs the FULL audit stack (axe + india +
// is17802 + media) + content-signals + full-page screenshot. The result is a complete
// per-page record: violations/passes/incomplete/inapplicable, template
// fingerprint, content-type flags, actual component values, and a PNG
// screenshot blob. This replaces the earlier signals-only path on user
// direction — inventory mode IS the full audit, not a lightweight preview.
async function inventoryInNewTab(url, collectNextLinks, { queue = null, seenTextHashes = null } = {}) {
  const tab = await createWorkerTab(url); // v0.4.3 — opens in the minimized crawler window
  const tabId = tab.id;
  let inFlightClaimKey = null; // set if we claim a slot; released in finally
  try {
    await waitForTabComplete(tabId, TAB_TIMEOUT_MS);

    // v12 fix — pre-sleep in-flight check. See _inFlightSettleUrls comment.
    // If another worker's tab has already landed at the same post-load URL
    // and is holding the slot while waiting out the settle window, this worker
    // aborts immediately instead of duplicating the scan.
    if (queue) {
      let currentUrl = null;
      try {
        const t = await chrome.tabs.get(tabId);
        currentUrl = t?.url || null;
      } catch {}
      if (currentUrl) {
        const keyUrl = canonicalize(currentUrl) || currentUrl;
        // Fast path — another worker already COMPLETED a scan at this URL
        if (queue.hasSettled(keyUrl, url)) {
          console.log(`[EU] pre-sleep dedup skip: ${url} → ${keyUrl} (already scanned)`);
          return { __skipped: "pre-sleep-already-scanned", settledUrl: keyUrl, title: "" };
        }
        // Race-closer — another worker is MID-FLIGHT at this URL
        if (_inFlightSettleUrls.has(keyUrl)) {
          console.log(`[EU] pre-sleep dedup skip: ${url} → ${keyUrl} (in flight on another tab)`);
          return { __skipped: "pre-sleep-in-flight", settledUrl: keyUrl, title: "" };
        }
        // Atomic claim (no await between .has() and .add() above).
        _inFlightSettleUrls.add(keyUrl);
        inFlightClaimKey = keyUrl;
      }
    }

    await adaptiveSettle(tabId);

    // Settled-URL dedup — MUST come after the settle. waitForTabComplete
    // resolves on the initial URL's "complete" state, but JavaScript-based
    // redirects (typical of disclosure-gate / age-gate / session-wall sites)
    // fire AFTER complete, so we have to give the settle window time to run.
    // We also poll briefly once more to catch late redirects.
    if (queue) {
      const settledUrl = await waitForUrlSettle(tabId);
      console.log(`[EU] worker settled: queued=${url}  → settled=${settledUrl}`);
      if (settledUrl && queue.hasSettled(settledUrl, url)) {
        console.log(`[EU] dedup skip: ${url} → ${settledUrl} (already scanned)`);
        return {
          __skipped: "redirect-to-duplicate",
          settledUrl,
          title: ""
        };
      }
      if (settledUrl) queue.markSettled(settledUrl, url);
    }

    // Full audit stack — axe + custom check bundles via the content script.
    await injectAxe(tabId);
    const auditPayload = await runContentScan(tabId);

    // Content signals (with shadow DOM, actual values, static/dynamic class).
    const signals = await collectContentSignals(tabId);

    // v0.4.4 — rendered-DOM soft-404 check (SPA-safe: sees what JavaScript
    // actually painted, not what the server sent).
    const soft404 = await checkRendered404(tabId);

    // v0.2.6 — Content-hash dedup check. runContentScan returns the
    // page's rendered-text hash; if another worker already produced the
    // same hash, this page is the same content served under a different
    // URL. Skip the (expensive) full-page screenshot and tag the record
    // with `duplicate_of` so buildInventory can collapse it into the
    // primary page. Axe output is retained unchanged — since the content
    // is identical, the issues will match the primary anyway, and
    // buildInventory's dedup drops the duplicate's rows. The screenshot
    // is the only heavy operation we can avoid at this stage without
    // splitting runContentScan in two.
    const tmpl = auditPayload?.template || {};
    const textHash = tmpl.textHash || "";
    let duplicateOf = null;
    if (seenTextHashes && textHash) {
      const firstUrl = seenTextHashes.get(textHash);
      if (firstUrl && firstUrl !== url) {
        duplicateOf = firstUrl;
      } else if (!firstUrl) {
        seenTextHashes.set(textHash, url);
      }
    }

    // Full-page screenshot via chrome.debugger. Falls back gracefully to
    // visible-viewport capture if debugger attach is refused (e.g. DevTools
    // already open on this tab, chrome:// URL, policy). Skipped on
    // content-hash duplicates (see block above).
    let screenshot = null;
    if (ACTIVE_SCREENSHOTS && !duplicateOf) {
      try {
        screenshot = await captureFullPageScreenshot(tabId, auditPayload?.violations || null);
      } catch (err) {
        console.warn(`[EU] screenshot failed for ${url}:`, err?.message || err);
      }
    } else if (duplicateOf) {
      console.log(`[EU] content-hash dupe — skipping screenshot for ${url} (duplicate of ${duplicateOf})`);
    }

    const out = {
      title: auditPayload?.title || tab.title || "",
      ...(soft404 ? { soft404 } : {}),
      template_id: tmpl.fingerprint || "unknown",
      url_cluster: tmpl.urlCluster || "unknown",
      text_hash: textHash,
      // v0.4.0 team-merge — DOM simhash + top-level tag preview.
      dom_hash: tmpl.domHash || "",
      dom_preview: tmpl.domPreview || "",
      element_counts: tmpl.elementCounts || {},
      // Full audit — same shape as multi-page mode.
      audit: {
        scanStartedAt: auditPayload?.scanStartedAt || null,
        scanDurationMs: auditPayload?.scanDurationMs || 0,
        testEngine: auditPayload?.testEngine || null,
        testRunner: auditPayload?.testRunner || null,
        testEnvironment: auditPayload?.testEnvironment || null,
        toolOptions: auditPayload?.toolOptions || null,
        axeTimestamp: auditPayload?.axeTimestamp || null,
        axeUrl: auditPayload?.axeUrl || null,
        violations: auditPayload?.violations || [],
        passes: auditPayload?.passes || [],
        incomplete: auditPayload?.incomplete || [],
        inapplicable: auditPayload?.inapplicable || []
      },
      // v0.4.8 — see the seed-page record in scanInventory: media inventory
      // must survive into the page record for mediaRows / PDF & Office audits.
      mediaInventory: auditPayload?.mediaInventory || null,
      screenshot, // { dataUrl, width, height } | null
      duplicate_of: duplicateOf, // URL of first page with same text_hash, else null
      ...signals
    };
    if (collectNextLinks) {
      try { out.links = await collectNavLinks(tabId); } catch { out.links = []; }
    }
    return out;
  } finally {
    if (inFlightClaimKey) _inFlightSettleUrls.delete(inFlightClaimKey);
    try { await chrome.tabs.remove(tabId); } catch {}
  }
}

// Capture a true full-page screenshot via chrome.debugger + DevTools Protocol.
// This is the only in-Chrome way to get below-the-fold content in a single
// call (viewport captureVisibleTab only sees what's currently visible).
// Trade-off: a yellow "being debugged" bar appears on the target tab while
// debugger is attached. For background tabs that's invisible to the user.
//
// The large PNG data URL is NOT returned on the page record. Instead we
// stash it in `inventoryScreenshots` keyed by a short id and return just the
// reference. This keeps the inventory payload small enough to pass through
// chrome.runtime.sendMessage (practical ceiling ~32-64MB) even on crawls of
// hundreds of full-page screenshots. The renderer fetches each image on
// demand via the GET_SCREENSHOT message.
// v12.2 — wrap each debugger call in a race-with-timeout so a stuck
// chrome.debugger.attach can't hang the worker (and therefore the whole
// pool) forever. Chrome throttles/queues concurrent debugger sessions
// when many tabs request attach at once (concurrent workers can still
// exceed the practical ceiling). Before this cap, an attach that got
// queued past Chrome's internal timeout just never resolved, which left
// the worker stuck mid-`inventoryInNewTab` with its tab still open.
const DEBUGGER_ATTACH_TIMEOUT_MS = 15_000;
const DEBUGGER_CMD_TIMEOUT_MS = 20_000;

function withTimeout(promise, ms, label) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error(`${label} timeout after ${ms}ms`)), ms);
    promise.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

async function captureFullPageScreenshot(tabId, violations = null) {
  const target = { tabId };
  let attached = false;
  try {
    await withTimeout(chrome.debugger.attach(target, "1.3"), DEBUGGER_ATTACH_TIMEOUT_MS, "debugger.attach");
    attached = true;
    await withTimeout(chrome.debugger.sendCommand(target, "Page.enable"), DEBUGGER_CMD_TIMEOUT_MS, "Page.enable");
    const result = await withTimeout(
      chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
        format: "png",
        captureBeyondViewport: true,
        fromSurface: true
      }),
      DEBUGGER_CMD_TIMEOUT_MS,
      "Page.captureScreenshot"
    );
    let shot = null;
    if (result?.data) {
      const id = `shot-${crypto.randomUUID()}`;
      inventoryScreenshots.set(id, { dataUrl: `data:image/png;base64,${result.data}`, bytes: result.data.length });
      shot = { id, bytes: result.data.length };
    }
    // v0.4.2 — issue-specific element screenshots. Reuse THIS debugger session
    // (one attach per page — attaching a second time would double the
    // contention the 200-tab pool already strains) to capture a cropped,
    // highlighted shot of each distinct violating element. Mutates the
    // violation nodes in place, tagging each with elementShotId so the report
    // and the Excel can show the issue exactly where it occurs.
    if (Array.isArray(violations) && violations.length) {
      try {
        const n = await captureElementShotsInSession(target, violations);
        if (n) console.log(`[EU] captured ${n} element screenshot(s)`);
      } catch (err) {
        console.warn("[EU] element screenshots failed:", err?.message || err);
      }
    }
    return shot;
  } finally {
    if (attached) {
      try { await withTimeout(chrome.debugger.detach(target), 5_000, "debugger.detach"); } catch {}
    }
  }
}

// Per-page cap + context padding (CSS px) for issue-specific element shots.
const MAX_ELEMENT_SHOTS_PER_PAGE = 30;
const ELEMENT_SHOT_PAD = 14;
const ELEMENT_SHOT_MAX_DIM = 1600;

// Within an already-attached debugger session, capture one highlighted, cropped
// screenshot per DISTINCT violating element. Deduped by selector and capped so
// a page with hundreds of nodes can't explode storage/time. Tags each matched
// violation node with `elementShotId`. Returns the number captured.
async function captureElementShotsInSession(target, violations) {
  const selToNodes = new Map();
  for (const v of violations) {
    for (const n of (v.nodes || [])) {
      const sel = elementSelectorOf(n);
      if (!sel) continue;
      if (!selToNodes.has(sel)) selToNodes.set(sel, []);
      selToNodes.get(sel).push(n);
    }
  }
  if (selToNodes.size === 0) return 0;
  await withTimeout(chrome.debugger.sendCommand(target, "Runtime.enable"), DEBUGGER_CMD_TIMEOUT_MS, "Runtime.enable");
  let captured = 0;
  for (const sel of [...selToNodes.keys()].slice(0, MAX_ELEMENT_SHOTS_PER_PAGE)) {
    try {
      const evalRes = await withTimeout(chrome.debugger.sendCommand(target, "Runtime.evaluate", {
        expression: elementHighlightExpr(sel), returnByValue: true
      }), DEBUGGER_CMD_TIMEOUT_MS, "Runtime.evaluate(highlight)");
      const rect = evalRes?.result?.value;
      if (!rect || !rect.ok) { await clearElementHighlight(target); continue; }
      const clip = {
        x: Math.max(0, rect.x), y: Math.max(0, rect.y),
        width: Math.max(1, Math.min(rect.width, ELEMENT_SHOT_MAX_DIM)),
        height: Math.max(1, Math.min(rect.height, ELEMENT_SHOT_MAX_DIM)),
        scale: 1
      };
      const shot = await withTimeout(chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
        format: "png", captureBeyondViewport: true, fromSurface: true, clip
      }), DEBUGGER_CMD_TIMEOUT_MS, "Page.captureScreenshot(element)");
      await clearElementHighlight(target);
      if (!shot?.data) continue;
      const id = `shot-el-${crypto.randomUUID()}`;
      inventoryScreenshots.set(id, { dataUrl: `data:image/png;base64,${shot.data}`, bytes: shot.data.length });
      for (const node of selToNodes.get(sel)) node.elementShotId = id;
      captured++;
    } catch (err) {
      console.warn(`[EU] element shot failed (${sel}):`, err?.message || err);
      try { await clearElementHighlight(target); } catch {}
    }
  }
  return captured;
}

// axe node.target is frame-aware (an array). Top-frame nodes carry a single CSS
// selector string; nested-frame targets (length > 1) can't be queried from the
// top document, so we skip them.
function elementSelectorOf(node) {
  const t = node && node.target;
  if (Array.isArray(t)) return (t.length === 1 && typeof t[0] === "string") ? t[0] : null;
  if (typeof t === "string") return t;
  return null;
}

// Page-side expression: outline the element (outline doesn't reflow layout),
// scroll it into view, and return its page-space rect (+ padding). Stashes the
// previous inline styles on window so clearElementHighlight can restore them.
function elementHighlightExpr(sel) {
  return `(function(){
    try {
      var el = document.querySelector(${JSON.stringify(sel)});
      if (!el || !el.getBoundingClientRect) return { ok:false };
      try { el.scrollIntoView({block:'center', inline:'center'}); } catch(e){}
      var r = el.getBoundingClientRect();
      window.__EU_HL = { el: el, outline: el.style.outline, offset: el.style.outlineOffset, shadow: el.style.boxShadow };
      el.style.outline = '3px solid #e11d48';
      el.style.outlineOffset = '2px';
      el.style.boxShadow = '0 0 0 4px rgba(225,29,72,0.35)';
      var pad = ${ELEMENT_SHOT_PAD};
      return { ok: (r.width>0 && r.height>0),
        x: r.left + window.scrollX - pad, y: r.top + window.scrollY - pad,
        width: r.width + pad*2, height: r.height + pad*2 };
    } catch(e){ return { ok:false }; }
  })()`;
}

async function clearElementHighlight(target) {
  try {
    await withTimeout(chrome.debugger.sendCommand(target, "Runtime.evaluate", {
      expression: `(function(){ try { var h=window.__EU_HL; if(h&&h.el){ h.el.style.outline=h.outline; h.el.style.outlineOffset=h.offset; h.el.style.boxShadow=h.shadow; } window.__EU_HL=null; } catch(e){} })()`
    }), 5000, "clearElementHighlight");
  } catch {}
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

// v13.1 — enrich PDF media rows with a structural audit pass. Fetches
// each unique PDF URL discovered during crawl and inspects it for the
// four structural markers a tagged, AT-friendly PDF must declare:
// /MarkInfo, /StructTreeRoot, /Lang, /Title. Issues are appended to the
// per-item `issues` array so the report renders them alongside existing
// media-checks.js findings; full audit result is attached as
// `mediaRow.pdfAudit` for the report to surface the positive values
// (detected language, title, size) as well.
async function enrichPdfRowsWithAudit(inventory) {
  const rows = inventory?.mediaRows;
  if (!Array.isArray(rows) || rows.length === 0) return;
  const pdfRows = rows.filter(r => r && (r.family === "pdf" || r.subtype === "pdf"));
  if (pdfRows.length === 0) return;

  // De-duplicate by media_url — same PDF linked from 50 pages should
  // only be fetched once, then the result mirrored across every row.
  const urls = [...new Set(pdfRows.map(r => r.media_url).filter(Boolean))];
  if (urls.length === 0) return;

  console.log(`[EU] PDF audit — inspecting ${urls.length} unique PDF(s) across ${pdfRows.length} link(s)`);
  let results;
  try {
    results = await auditPdfUrls(urls, {
      concurrency: 4,
      timeoutMs: 12000,
      progress: (done, total, url) => {
        if (done % 5 === 0 || done === total) {
          console.log(`[EU] PDF audit ${done}/${total} — ${url}`);
        }
      }
    });
  } catch (err) {
    console.warn("[EU] PDF audit batch failed", err);
    return;
  }

  let totalIssues = 0;
  for (const row of pdfRows) {
    const r = results.get(row.media_url);
    if (!r) continue;
    row.pdfAudit = r;
    if (!r.ok) continue;
    const issues = pdfAuditToIssues(r);
    if (issues.length === 0) continue;
    row.issues = Array.isArray(row.issues) ? row.issues : [];
    for (const iss of issues) {
      row.issues.push(iss.id);
      totalIssues++;
    }
    row.pdfAuditIssues = issues;
    row.issue_count = (row.issues || []).length;
  }

  // Roll up into mediaSummary so the summary tile shows "documentIssues"
  // reflecting the new PDF structural findings.
  if (inventory.mediaSummary) {
    inventory.mediaSummary.documentIssues = (inventory.mediaSummary.documentIssues || 0) + totalIssues;
    inventory.mediaSummary.pdfsAudited = results.size;
    inventory.mediaSummary.pdfAuditIssues = totalIssues;
  }
  console.log(`[EU] PDF audit — ${totalIssues} structural issue(s) across ${results.size} PDF(s)`);
}

// v0.2.2 — byte-level audit of every crawled Office document (docx/xlsx/
// pptx). Same plumbing as enrichPdfRowsWithAudit: filter by subtype, de-
// dup by media_url, call the batch runner, fold each result back onto
// the row with row.officeAudit + append rule-shaped issues to row.issues,
// then roll counts up to mediaSummary.documentIssues so the summary tile
// reflects the Office findings alongside PDF findings.
async function enrichOfficeRowsWithAudit(inventory) {
  const rows = inventory?.mediaRows;
  if (!Array.isArray(rows) || rows.length === 0) return;
  const officeRows = rows.filter(r => r && /^(docx|xlsx|pptx)$/i.test(r.subtype || ""));
  if (officeRows.length === 0) return;

  const urls = [...new Set(officeRows.map(r => r.media_url).filter(Boolean))];
  if (urls.length === 0) return;

  console.log(`[EU] Office audit — inspecting ${urls.length} unique Office doc(s) across ${officeRows.length} link(s)`);
  let results;
  try {
    results = await auditOfficeUrls(urls, {
      concurrency: 4,
      timeoutMs: 15000,
      progress: (done, total, url) => {
        if (done % 5 === 0 || done === total) {
          console.log(`[EU] Office audit ${done}/${total} — ${url}`);
        }
      }
    });
  } catch (err) {
    console.warn("[EU] Office audit batch failed", err);
    return;
  }

  let totalIssues = 0;
  for (const row of officeRows) {
    const r = results.get(row.media_url);
    if (!r) continue;
    row.officeAudit = r;
    if (!r.ok) continue;
    const issues = officeAuditToIssues(r);
    if (issues.length === 0) continue;
    row.issues = Array.isArray(row.issues) ? row.issues : [];
    for (const iss of issues) {
      row.issues.push(iss.id);
      totalIssues++;
    }
    row.officeAuditIssues = issues;
    row.issue_count = (row.issues || []).length;
  }

  if (inventory.mediaSummary) {
    inventory.mediaSummary.documentIssues = (inventory.mediaSummary.documentIssues || 0) + totalIssues;
    inventory.mediaSummary.officeAudited = results.size;
    inventory.mediaSummary.officeAuditIssues = totalIssues;
  }
  console.log(`[EU] Office audit — ${totalIssues} structural issue(s) across ${results.size} Office doc(s)`);
}

function buildInventory(pages, meta) {
  // ── Shell / soft-404 detection ─────────────────────────────────────
  // The seed page (the URL the user originally gave us) is the reference
  // shell. Any subsequently-crawled page whose DOM fingerprint AND text hash
  // BOTH match the seed's is almost certainly either the SPA's shell
  // returned on unknown routes (a soft-404) or a duplicate of the homepage.
  // We keep them in a separate bucket for transparency but exclude from
  // the main pages / templates tables so the inventory reflects real
  // distinct pages.
  //
  // meta.noDedup: paste-mode (scanList). The operator handed us the exact
  // URL set — every pasted URL MUST render as its own row, with no shell
  // bucketing, no canonical/finalUrl collapse, nothing hidden. Template
  // clustering is still computed and shown in the Templates section so the
  // operator can see which pasted URLs share a shell, but every page stays
  // in the main table. The v6 principle (never hide rows the operator
  // explicitly asked to see) applies with extra force here because the
  // operator hand-picked the list.
  const noDedup = !!meta?.noDedup;

  const seedPage = pages.find(p => p.source === "seed" && !p.error) || null;
  const seedFp = seedPage?.template_id || null;
  const seedTextHash = seedPage?.text_hash || null;
  const shellPages = [];
  const realPagesRaw = [];
  if (noDedup) {
    // Paste-mode: every page goes to realPagesRaw. No shell sidelining.
    for (const p of pages) realPagesRaw.push(p);
  } else {
    // v0.2.5 — shell detection runs in two passes:
    //
    //   Pass A (seed-shell): any non-seed page whose (template_id,
    //   text_hash) matches the seed's is a soft-404 to the home route.
    //   This is the classic SPA case where /about and /contact and /foo
    //   all fall through to the home template because the client router
    //   doesn't have a matching route.
    //
    //   Pass B (cluster-shell): group non-seed non-error pages by
    //   (template_id, text_hash). A cluster is treated as a phantom
    //   (identical-shell-cluster) ONLY IF it has ≥2 distinct URL PATHS
    //   (ignoring query string + fragment). Canonical phantom example:
    //   Metronic / admin-template sites where the sidebar has dozens of
    //   demo links (/crafted/*, /apps/chat/*, /error/*) that all 404 in
    //   production to the same "page not found" template — those have
    //   different paths, so they collapse. But a blog listing page
    //   (/blog, /blog?tag=insights, /blog?tag=newsletters) that all
    //   render the same pre-filter DOM shares ONE path and is a
    //   legitimate filter-variant pattern — those stay in realPagesRaw.
    //   The (fp, text) key cannot collapse legitimate template clusters
    //   because real template pages have DIFFERENT text_hash values
    //   (their content differs), so they end up in separate clusters of
    //   1 and stay in realPagesRaw.
    const pathOf = (url) => {
      try { return new URL(url).pathname || "/"; } catch { return url || ""; }
    };
    const groups = new Map(); // `${fp}::${textHash}` → [page, …]
    for (const p of pages) {
      if (p.error) { realPagesRaw.push(p); continue; }
      if (p === seedPage) { realPagesRaw.push(p); continue; }
      const fp = p.template_id || "";
      const th = p.text_hash || "";
      if (!fp || !th) { realPagesRaw.push(p); continue; }
      const key = `${fp}::${th}`;
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(p);
    }
    for (const group of groups.values()) {
      const sample = group[0];
      const matchesSeed =
        seedFp && sample.template_id === seedFp &&
        seedTextHash && sample.text_hash === seedTextHash;
      // Distinct URL paths in the cluster (ignoring ?query and #frag).
      // Filter-variant pattern (same path, different query) is NOT a
      // phantom — it's legitimate filter views of one real page.
      const distinctPaths = new Set(group.map(p => pathOf(p.url)));
      const isPhantomCluster = group.length >= 2 && distinctPaths.size >= 2;
      if (matchesSeed) {
        for (const p of group) { p.isShell = true; p.shellReason = "matches-seed-shell"; shellPages.push(p); }
      } else if (isPhantomCluster) {
        for (const p of group) { p.isShell = true; p.shellReason = "identical-shell-cluster"; shellPages.push(p); }
      } else {
        // Either a solo cluster (normal page) or a same-path filter-variant
        // cluster (/foo, /foo?tag=x, /foo?tag=y). Keep all in realPagesRaw
        // — URL dedup downstream can collapse query-variants if desired.
        for (const p of group) realPagesRaw.push(p);
      }
    }
  }

  // ── Content-hash duplicate collapse (v0.2.6) ───────────────────────
  // Workers populate `duplicate_of` on a page record when its text_hash
  // matches an earlier-scanned URL's hash (see inventoryInNewTab). This
  // catches same-content-different-slug collisions that no URL-based
  // dedup can — e.g. two WordPress pages serving identical body content
  // under unrelated slugs (bio pages returning the same placeholder,
  // alias pages mapped to the same template render). The primary URL is
  // whichever one the worker scanned first; the duplicate gets folded
  // into the primary's alt_discoveries list and removed from the main
  // table, matching how shell pages are handled above. Errored records
  // and paste-mode are exempt — paste-mode must keep every requested row
  // as its own line regardless of hash collisions.
  const hashDuplicates = [];
  if (!noDedup) {
    const byUrlForHash = new Map();
    for (const p of realPagesRaw) {
      if (p.error) continue;
      const key = p.canonicalUrl || p.finalUrl || p.url;
      if (key) byUrlForHash.set(key, p);
    }
    const kept = [];
    for (const p of realPagesRaw) {
      if (p.duplicate_of && !p.error) {
        const primary = byUrlForHash.get(p.duplicate_of);
        if (primary && primary !== p) {
          primary.alt_discoveries = primary.alt_discoveries || [];
          primary.alt_discoveries.push({
            depth: p.depth,
            source: p.source,
            template_id: p.template_id,
            text_hash: p.text_hash,
            url: p.url,
            finalUrl: p.finalUrl,
            canonicalUrl: p.canonicalUrl,
            reason: "same-content-hash"
          });
          primary.visit_count = (primary.visit_count || 1) + 1;
          hashDuplicates.push(p);
          continue;
        }
      }
      kept.push(p);
    }
    realPagesRaw.length = 0;
    for (const p of kept) realPagesRaw.push(p);
  }

  // ── User-journey URL dedup ─────────────────────────────────────────
  // Collapses pages that a real human browser-user would consider the
  // same destination, even if the crawler reached them via different
  // queued URLs. Priority (highest first):
  //
  //   1. canonicalUrl — site-declared via <link rel="canonical">. If two
  //      URLs declare the same canonical, they are the same page by the
  //      site's own claim.
  //   2. finalUrl — the post-settle URL after client-side redirects /
  //      server 301/302. Collapses http → https, trailing-slash variants,
  //      and SPAs that strip tracking params on load (?from=home vs
  //      ?from=footer both land on /foo).
  //   3. queued url — the URL the queue actually fetched. Fallback for
  //      pages whose canonical is absent AND whose finalUrl matches the
  //      queued url.
  //
  // For each collapse we also record WHY so dedupSummary can explain
  // itself to the auditor (by_canonical / by_final_url / by_queued_url).
  function scoreRecord(p) {
    if (p.error) return -1;
    let s = 0;
    s += (p.audit?.violations || []).length * 10;
    s += (p.audit?.incomplete || []).length * 5;
    s += (p.audit?.passes || []).length;
    if (p.screenshot?.id) s += 50;
    if (p.components) s += 20;
    if (p.counts) s += Object.values(p.counts).filter(v => Number(v) > 0).length;
    return s;
  }
  function dedupKey(p) {
    if (p.error) return `__err_${p.url || Math.random()}`;
    // v0.2.7 — Anchor the canonical-based key to text_hash. Sites
    // (especially SPAs) frequently bake ONE <link rel="canonical"> tag
    // into the HTML shell and never update it as the user navigates, so
    // every route reports the same canonical. Trusting that tag blindly
    // collapses legitimate separate pages together — on greysky.capital
    // this folded the homepage into an unrelated page because they
    // shared a canonical but had clearly different text. The fix: two
    // URLs dedup by canonical ONLY when their rendered-text hash also
    // matches. Same canonical + same text = legitimate duplicate. Same
    // canonical + different text = misconfigured canonical tag; trust
    // the content. If text_hash is missing (couldn't compute), fall
    // back to canonical-only so at least pre-v0.2.7 behaviour is kept.
    if (p.canonicalUrl) {
      return p.text_hash ? `${p.canonicalUrl}||${p.text_hash}` : p.canonicalUrl;
    }
    return p.finalUrl || p.url || `__noid`;
  }
  const dedupReason = { by_canonical: 0, by_final_url: 0, by_queued_url: 0 };
  let realPages;
  if (noDedup) {
    // Paste-mode: one row per scanned page, preserving input order.
    realPages = realPagesRaw.slice();
  } else {
    const byUrl = new Map();
    for (const p of realPagesRaw) {
      const key = dedupKey(p);
      const existing = byUrl.get(key);
      if (!existing) {
        byUrl.set(key, { record: p, alt: [], visits: 1 });
        continue;
      }
      existing.visits++;
      // Attribute the collapse to whichever signal matched.
      if (p.canonicalUrl && p.canonicalUrl === existing.record.canonicalUrl) {
        dedupReason.by_canonical++;
      } else if (p.finalUrl && p.finalUrl === existing.record.finalUrl && p.finalUrl !== p.url) {
        dedupReason.by_final_url++;
      } else {
        dedupReason.by_queued_url++;
      }
      // Preserve the alternate discovery context
      existing.alt.push({
        depth: p.depth,
        source: p.source,
        template_id: p.template_id,
        text_hash: p.text_hash,
        url: p.url,
        finalUrl: p.finalUrl,
        canonicalUrl: p.canonicalUrl
      });
      // v0.2.7 — Seed protection. The seed URL is the user's entry point;
      // dropping it in favour of a higher-scoring collision (common when
      // many SPA routes share one canonical tag) hides the homepage from
      // the inventory entirely. If either record is the seed, keep the
      // seed as primary regardless of score — the other URL still lands
      // in alt_discoveries so nothing is lost.
      const existingIsSeed = existing.record.source === "seed";
      const newIsSeed = p.source === "seed";
      const shouldPromote = newIsSeed
        ? true
        : existingIsSeed
          ? false
          : scoreRecord(p) > scoreRecord(existing.record);
      // If this visit scored higher (or is the seed), promote it and
      // push the previous into alt.
      if (shouldPromote) {
        existing.alt.push({
          depth: existing.record.depth,
          source: existing.record.source,
          template_id: existing.record.template_id,
          text_hash: existing.record.text_hash,
          url: existing.record.url,
          finalUrl: existing.record.finalUrl,
          canonicalUrl: existing.record.canonicalUrl
        });
        existing.record = p;
      }
    }
    realPages = [];
    for (const { record, alt, visits } of byUrl.values()) {
      if (visits > 1) {
        record.visit_count = visits;
        record.alt_discoveries = alt;
      }
      realPages.push(record);
    }
  }

  // Dedup is URL-exact first (canonical → finalUrl → queued URL) via the
  // first-pass loop above. Template-based and audit-signature-based
  // single-key collapses have been removed (v6): two audit-distinct pages
  // that happen to share a shell (team profiles, portfolio entries, news
  // posts) must stay as SEPARATE URLs because they ARE separate human
  // destinations.
  //
  // v12 adds a second, narrow pass — "cross-folder same-slug dedup" —
  // that catches a specific phantom pattern the URL-exact pass misses:
  // the same content served under two different URL paths (e.g.
  // /services/web-design AND /web-design, or /about/team AND
  // /company/team). These share no canonical, no finalUrl, no queued URL,
  // so URL-exact dedup treats them as two rows. They DO share four
  // characteristics simultaneously, and requiring all four is what keeps
  // this pass safe from the v6 over-collapse failure mode:
  //
  //   1. Same template class (from classifyTemplate: home / legal / auth
  //      / blog-post / html-sitemap / other).
  //   2. Same leaf slug (last path segment after language-tag strip).
  //   3. Same template_id (DOM fingerprint — full structural hash).
  //   4. Same text_hash (rendered text content hash).
  //
  // Conjunction (3) AND (4) is what distinguishes this from the v6 failure:
  //   • Two team profile pages share template_id but DIFFERENT text_hash.
  //     → NOT collapsed (different content). ✓
  //   • Two portfolio items share template_id but DIFFERENT text_hash.
  //     → NOT collapsed. ✓
  //   • /services/web-design and /web-design share EVERYTHING.
  //     → Collapsed. Shortest path wins. ✓
  //
  // Dropped URLs are preserved on the winner's alt_discoveries list so
  // the operator can audit the dedup decision, exactly as URL-exact
  // dedup does.
  const crossFolderReason = { cross_folder_dropped: 0 };
  if (!noDedup && realPages.length > 1) {
    const byTuple = new Map();
    for (const p of realPages) {
      if (p.error) continue;
      const slugKey = templateSlugKey(p.canonicalUrl || p.finalUrl || p.url);
      const fp = p.template_id || "";
      const th = p.text_hash || "";
      // Require non-empty fingerprint AND non-empty text hash. Without
      // both, we can't tell "same content, different URL" from "two
      // blank records we couldn't fingerprint". Records without both
      // hashes pass through untouched.
      if (!slugKey || !fp || !th) continue;
      const key = `${slugKey}||${fp}||${th}`;
      const arr = byTuple.get(key);
      if (!arr) byTuple.set(key, [p]);
      else arr.push(p);
    }
    const toDrop = new Set();
    for (const group of byTuple.values()) {
      if (group.length < 2) continue;
      // Shortest path wins. Ties broken by the existing scoreRecord()
      // (more signal = better record to keep).
      group.sort((a, b) => {
        const ua = a.canonicalUrl || a.finalUrl || a.url || "";
        const ub = b.canonicalUrl || b.finalUrl || b.url || "";
        const la = (new URL(ua, "http://x").pathname).split("/").filter(Boolean).length;
        const lb = (new URL(ub, "http://x").pathname).split("/").filter(Boolean).length;
        if (la !== lb) return la - lb;
        return scoreRecord(b) - scoreRecord(a);
      });
      const winner = group[0];
      winner.alt_discoveries = winner.alt_discoveries || [];
      for (let i = 1; i < group.length; i++) {
        const d = group[i];
        winner.alt_discoveries.push({
          depth: d.depth,
          source: d.source,
          template_id: d.template_id,
          text_hash: d.text_hash,
          url: d.url,
          finalUrl: d.finalUrl,
          canonicalUrl: d.canonicalUrl,
          cross_folder_reason: "same-slug-same-fingerprint-same-text"
        });
        toDrop.add(d);
        crossFolderReason.cross_folder_dropped++;
      }
      winner.visit_count = (winner.visit_count || 1) + (group.length - 1);
    }
    if (toDrop.size > 0) {
      realPages = realPages.filter(p => !toDrop.has(p));
    }
  }

  // template_id and text_hash are still computed per-record and carried
  // through — the report renders "template cluster" groupings from them
  // so an auditor can see which pages share a shell without those pages
  // being dropped from the inventory.
  const dedupSummary = {
    raw_page_count: realPagesRaw.length,
    unique_urls: realPages.length,
    duplicates_collapsed: realPagesRaw.length - realPages.length,
    by_canonical: dedupReason.by_canonical,
    by_final_url: dedupReason.by_final_url,
    by_queued_url: dedupReason.by_queued_url,
    by_cross_folder: crossFolderReason.cross_folder_dropped
  };

  // Group by template fingerprint ALONE. Previously the key was
  // `fingerprint|url_cluster` which fragmented SPA shells into N rows (one
  // per URL path). Now many URL paths sharing the same fingerprint cluster
  // as one template, with the full set of distinct url_clusters carried
  // along as a facet (so the viewer can still show "this template spans
  // /about, /team, /services, …").
  const groups = new Map();
  const contentTypeSummary = {
    "Forms": 0, "Data Tables": 0, "Video": 0, "Audio": 0,
    "Iframes": 0, "Modals": 0, "Carousels": 0, "Tabs": 0,
    "Menus": 0, "Accordions": 0, "Datepickers": 0, "Dropdowns": 0,
    "PDF Links": 0, "Login": 0, "CAPTCHA": 0, "Shadow DOM": 0,
    "Dynamic Pages (SPA)": 0, "Static Pages": 0
  };
  const testsUnion = new Map(); // test → why

  // Corpus-level audit roll-up — total violations/incomplete/passes across the
  // inventory. Lets the scope document answer "how big is this audit?" in a
  // single number.
  const corpusAudit = { violations: 0, incomplete: 0, passes: 0, inapplicable: 0, pagesAudited: 0, pagesScreenshotted: 0 };

  for (const p of realPages) {
    if (p.error) continue;
    const key = p.template_id || "unknown";
    let g = groups.get(key);
    if (!g) {
      g = {
        template_id: p.template_id,
        url_cluster: p.url_cluster, // primary (first-seen) cluster label
        url_clusters: new Set(),   // all distinct clusters in this template
        page_count: 0, pages: [],
        sample_url: p.url, sample_title: p.title || "",
        sample_pageType: p.pageType || "unknown",
        sample_spaMarkers: p.spaMarkers || [],
        sample_components: p.components || null,
        sample_screenshot: p.screenshot || null,
        sample_audit: p.audit || null,
        flags: {}, recommendedTests: [], testSet: new Set(),
        aggregatedCounts: {},
        totalViolations: 0, totalIncomplete: 0, totalPasses: 0,
        isSPA: false
      };
      groups.set(key, g);
    }
    if (p.url_cluster) g.url_clusters.add(p.url_cluster);
    g.page_count++;
    g.pages.push({
      url: p.url,
      title: p.title || "",
      pageType: p.pageType || "unknown",
      violations: (p.audit?.violations || []).length,
      incomplete: (p.audit?.incomplete || []).length,
      passes: (p.audit?.passes || []).length,
      hasScreenshot: !!p.screenshot?.id
    });
    // Aggregate audit roll-up per template + corpus.
    g.totalViolations += (p.audit?.violations || []).length;
    g.totalIncomplete += (p.audit?.incomplete || []).length;
    g.totalPasses += (p.audit?.passes || []).length;
    if (p.audit) {
      corpusAudit.pagesAudited++;
      corpusAudit.violations += (p.audit.violations || []).length;
      corpusAudit.incomplete += (p.audit.incomplete || []).length;
      corpusAudit.passes += (p.audit.passes || []).length;
      corpusAudit.inapplicable += (p.audit.inapplicable || []).length;
    }
    if (p.screenshot?.id) corpusAudit.pagesScreenshotted++;
    if (p.flags?.isSPA) g.isSPA = true;
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
    if (p.pageType === "dynamic") contentTypeSummary["Dynamic Pages (SPA)"]++;
    else if (p.pageType === "static") contentTypeSummary["Static Pages"]++;
  }

  const templates = [...groups.values()]
    .map(g => {
      const signalBits = [];
      if (g.isSPA) signalBits.push("SPA");
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
      const clusterList = [...g.url_clusters];
      return {
        template_id: g.template_id,
        url_cluster: g.url_cluster, // primary cluster (first-seen)
        url_clusters: clusterList,  // full set
        cluster_count: clusterList.length,
        page_count: g.page_count, sample_url: g.sample_url,
        sample_title: g.sample_title,
        sample_pageType: g.sample_pageType,
        sample_spaMarkers: g.sample_spaMarkers,
        sample_components: g.sample_components,
        sample_screenshot: g.sample_screenshot,
        sample_audit: g.sample_audit,
        pages: g.pages,
        isSPA: g.isSPA,
        flags: g.flags, recommendedTests: g.recommendedTests,
        totalViolations: g.totalViolations,
        totalIncomplete: g.totalIncomplete,
        totalPasses: g.totalPasses,
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

  // Compact shell-page summary for the viewer. Lets the operator see
  // "these 37 URLs all returned the homepage shell — probably soft-404s or
  // SPA route fallbacks" without these polluting the real inventory.
  // v0.2.6 — hash-duplicate summary. Lets the operator see which URLs
  // got folded into an earlier scan by content hash (same rendered text,
  // different URL) so nothing is silently dropped.
  const hashDuplicateSummary = hashDuplicates.length ? {
    count: hashDuplicates.length,
    sample_urls: hashDuplicates.slice(0, 20).map(p => ({ url: p.url, duplicate_of: p.duplicate_of })),
    explanation: "These URLs returned the same rendered-text content as another URL scanned earlier in this crawl. They were folded into the primary page's alt_discoveries and excluded from the main pages + templates tables. Screenshot capture was skipped on these to save time."
  } : null;

  const shellSummary = shellPages.length ? {
    count: shellPages.length,
    sample_urls: shellPages.slice(0, 20).map(p => p.url),
    by_reason: {
      matches_seed_shell: shellPages.filter(p => p.shellReason === "matches-seed-shell").length,
      identical_shell_cluster: shellPages.filter(p => p.shellReason === "identical-shell-cluster").length
    },
    explanation: "These URLs were crawled but returned a DOM + text identical to another crawled page. Two patterns are detected: (a) pages whose fingerprint + text matches the seed/home — typically an SPA client router soft-404'ing to the default route; (b) a cluster of ≥2 non-seed pages all rendering the same DOM + text — typically an error/404 page (common with admin-dashboard template sites whose sidebars carry many demo-route links that 404 in production). Excluded from the main pages + templates tables so they don't inflate inventory counts."
  } : null;

  // v0.4.8 — media & document rows across the real page set. This is what
  // enrichPdfRowsWithAudit / enrichOfficeRowsWithAudit iterate; before this,
  // inventory.mediaRows was never populated and both enrichers silently
  // no-oped on every inventory / template-check run. Shell and hash-duplicate
  // pages are excluded — their media is the same as the primary page's.
  const { mediaRows, mediaSummary } = collectMediaRows(realPages);

  return {
    meta: {
      ...meta,
      crawlDepthLabel: Number.isFinite(meta.crawlDepth) ? String(meta.crawlDepth) : "unbounded",
      generatedAt: new Date().toISOString()
    },
    mediaRows,
    mediaSummary,
    // `pages` is the real set (shell + hash-duplicate pages excluded).
    // Both sidelined sets are kept addressable so nothing is silently
    // dropped from the audit trail.
    pages: realPages,
    shellPages,
    shellSummary,
    hashDuplicates,
    hashDuplicateSummary,
    dedupSummary,
    templates, proposedSample, contentTypeSummary,
    corpusAudit,
    recommendedTestsUnion: [...testsUnion.entries()].map(([test, why]) => ({ test, why }))
  };
}

async function downloadInventoryFile(inventoryId, kind) {
  let entry = inventories.get(inventoryId);
  let inventory = entry?.inventory || null;
  let blob = entry?.files?.[kind] || null;

  // Memory miss → two scenarios:
  //   1. First-ever click since the crawl finished — inventory is in memory
  //      but blobs were never generated (we defer them to the download click
  //      so the viewer tab opens instantly after crawling).
  //   2. Service-worker eviction since the crawl — rebuild inventory from
  //      chrome.storage.local and regenerate the blob.
  if (!blob) {
    if (!inventory) {
      try {
        const key = `inv:${inventoryId}`;
        const stored = await chrome.storage.local.get(key);
        inventory = stored[key] || null;
      } catch (err) {
        console.warn("[EU] downloadInventoryFile storage fallback failed", err);
      }
    }
    if (!inventory) return { ok: false, error: "Inventory expired" };
    if (kind === "docx") blob = await buildScopeDocx(inventory);
    else if (kind === "clusters") blob = await buildClustersXlsx(inventory);
    else if (kind === "audit") blob = await buildAuditXlsx(inventory);
    else {
      // Inventory .xlsx — embed screenshot thumbnails in the Pages sheet.
      // buildThumbnailMap walks every page's screenshot, resizes it to a
      // modest preview (max 300px wide, 400px tall) using OffscreenCanvas,
      // and hands the resulting PNG bytes to the xlsx writer which wires
      // them into an OOXML drawing part. Failures on individual
      // screenshots are swallowed — a missing thumbnail just means that
      // row has no preview image; it does NOT fail the download.
      let thumbnails = null;
      try {
        thumbnails = await buildThumbnailMap(inventory);
      } catch (err) {
        console.warn("[EU] thumbnail pipeline failed — emitting xlsx without previews", err);
      }
      blob = await buildInventoryXlsx(inventory, { thumbnails });
    }
    // Cache the generated blob on the in-memory entry so a second click
    // doesn't rebuild it. If the entry is missing (storage-recovery path),
    // re-seat it so subsequent clicks on the other deliverable still hit
    // the fast path.
    if (!entry) {
      entry = { inventory, files: {} };
      inventories.set(inventoryId, entry);
    }
    entry.files[kind] = blob;
  }

  const dataUrl = await blobToDataUrl(blob);
  const host = inventory.meta.seedHost;
  const stamp = inventory.meta.generatedAt.replace(/[:.]/g, "-");
  const filename = kind === "docx"
    ? `enableuser-scope-${host}-${stamp}.docx`
    : kind === "clusters"
      ? `enableuser-clusters-${host}-${stamp}.xlsx`
      : kind === "audit"
        ? `enableuser-audit-${host}-${stamp}.xlsx`
        : `enableuser-inventory-${host}-${stamp}.xlsx`;
  await chrome.downloads.download({ url: dataUrl, filename, saveAs: false });
  return { ok: true };
}

// ─────────────────────────────────────────────────────────────────────
// Thumbnail pipeline — produces a Map<shotId, { bytes, width, height }>
// for the Pages sheet's embedded preview column. For each page with a
// screenshot we:
//   1. Resolve the full-size data: URL (in-memory Map first, then
//      chrome.storage.local — mirrors getScreenshot()).
//   2. Decode it into an ImageBitmap (fetch → blob → createImageBitmap;
//      all three APIs are available inside a service worker).
//   3. Scale to fit within 300px wide (aspect-preserving) and crop from
//      the top to 400px tall. Full-page screenshots are frequently
//      multi-thousand px tall; cropping the top gives a recognizable
//      "fold" preview without making every spreadsheet row 5000px tall.
//   4. Convert to PNG via OffscreenCanvas.convertToBlob → arrayBuffer.
//   5. Close the bitmap to release transferable memory.
//
// Failures on individual screenshots are swallowed — a missing thumbnail
// just means that row has no preview. We never throw from this function
// unless the caller's crawl had zero screenshots to begin with.
// ─────────────────────────────────────────────────────────────────────
async function buildThumbnailMap(inventory) {
  // Collect every shot id to thumbnail: full-page screenshots AND the
  // issue-specific element screenshots referenced by violation nodes.
  const ids = [];
  const seen = new Set();
  for (const p of (inventory?.pages || [])) {
    if (p.error) continue;
    if (p.screenshot?.id && !seen.has(p.screenshot.id)) { seen.add(p.screenshot.id); ids.push(p.screenshot.id); }
    for (const v of (p.audit?.violations || [])) {
      for (const n of (v.nodes || [])) {
        if (n.elementShotId && !seen.has(n.elementShotId)) { seen.add(n.elementShotId); ids.push(n.elementShotId); }
      }
    }
  }
  if (!ids.length) return null;

  const out = new Map();
  const MAX_W = 300;
  const MAX_H = 400;

  for (const id of ids) {
    let dataUrl = inventoryScreenshots.get(id)?.dataUrl || null;
    if (!dataUrl) {
      try {
        const stored = await chrome.storage.local.get(`shot:${id}`);
        dataUrl = stored[`shot:${id}`]?.dataUrl || null;
      } catch (err) {
        console.warn("[EU] thumbnail: storage lookup failed for", id, err);
      }
    }
    if (!dataUrl) continue;

    try {
      const blob = await (await fetch(dataUrl)).blob();
      const bitmap = await createImageBitmap(blob);

      // Width is scaled to fit MAX_W; height is scaled by the same factor.
      const scale = bitmap.width > MAX_W ? (MAX_W / bitmap.width) : 1;
      const scaledW = Math.max(1, Math.round(bitmap.width * scale));
      const scaledH = Math.max(1, Math.round(bitmap.height * scale));
      // Canvas height clamps to MAX_H — drawImage above MAX_H is clipped by
      // the canvas bounds, so we effectively crop the top region.
      const finalW = scaledW;
      const finalH = Math.min(scaledH, MAX_H);

      const canvas = new OffscreenCanvas(finalW, finalH);
      const ctx = canvas.getContext("2d");
      // Draw the full bitmap into the canvas scaled to (scaledW, scaledH);
      // any pixels past finalH are clipped.
      ctx.drawImage(bitmap, 0, 0, bitmap.width, bitmap.height, 0, 0, scaledW, scaledH);
      bitmap.close?.();

      const pngBlob = await canvas.convertToBlob({ type: "image/png" });
      const bytes = new Uint8Array(await pngBlob.arrayBuffer());
      out.set(id, { bytes, width: finalW, height: finalH });
    } catch (err) {
      console.warn("[EU] thumbnail resize failed for", id, err);
    }
  }

  return out;
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

async function collectNavLinks(tabId, opts = {}) {
  // opts.noScroll (v0.2.1) is forwarded into the in-page navSurfacedCollect
  // run. Pass true from seedDiscovery() because the seed tab IS the user's
  // visible tab — scrolling it makes the "Scan" button look broken. Leave
  // false for hidden worker tabs (inventoryInNewTab) which
  // open with active:false and can safely scroll for full nav harvest.
  const noScroll = !!(opts && opts.noScroll);
  try {
    const [{ result }] = await chrome.scripting.executeScript({
      target: { tabId },
      func: navSurfacedCollect,
      args: [{ noScroll }],
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

// ─────────────────────────────────────────────────────────────────────────
// seedDiscovery — runs every discovery source in parallel then enqueues
// candidates in strict priority order so a single noisy source (typically
// sitemap with thousands of entries) can't starve higher-value sources
// (nav, hreflang, rel=next/prev) when maxUrls is tight.
//
// Priority ladder (higher = enqueued first):
//   nav          8   ← from the rendered seed page, navSurfacedCollect
//   linkRel      7   ← <link rel="canonical"|"next"|"prev">
//   cms-api      6   ← WordPress /wp-json, Shopify /products.json
//   htmlSitemap  6   ← /sitemap HTML page (not sitemap.xml)
//   jsonLd       6   ← schema.org structured-data URLs on the seed page
//   framework    6   ← Next.js _buildManifest, Gatsby page-data
//   hreflang     5   ← locale alternates
//   feed         4   ← RSS / Atom / JSON feed entry URLs
//   sitemap      3   ← bucket-sampled across path prefixes when > budget
//   body         2   ← non-nav in-page links (blog thumbnails, card links)
//
// Sitemap URLs are bucket-sampled by first path segment so every section
// of the site gets representation rather than exhausting /news/ while
// /schemes/ and /contact/ never appear.
//
// v0.3.0 additions: WordPress REST API, Shopify products.json, HTML sitemap
// page auto-detect, Next.js build-manifest, Gatsby page-data, JSON-LD URL
// harvest. Each runs in parallel and is silently ignored on non-matching
// sites. Their discovery tags (cmsWordpress, cmsShopify, htmlSitemap,
// frameworkManifest, jsonLd) surface in discoveryStats so operators can
// see which source earned which URL on a per-site basis.
// ─────────────────────────────────────────────────────────────────────────
async function seedDiscovery({ tabId, startUrl, seedOrigin, queue, depth, discoveryStats, linksOnly = false, onLinks = null }) {
  // v0.4.3 — "real pages only" mode (SiteCrawler-style). Nulling the origin
  // disables every out-of-band source below (sitemap walk, robots.txt,
  // homepage <link> rels, RSS/Atom feeds, CMS API probes); only the in-page
  // nav harvest runs, so the crawl frontier is exactly what a human clicking
  // through the site could reach. No stale sitemap entries, no feed
  // archives, no API-only URLs.
  const oobOrigin = linksOnly ? null : seedOrigin;
  if (linksOnly) console.log("[EU] discovery: links-only mode — sitemap/feeds/CMS probes skipped");
  // Run all out-of-band discovery + nav-harvest + CMS probes in parallel.
  // navSurfacedCollect is the slow one (scroll + click-reveal, up to 45s);
  // CMS probes are HTTP-only and finish quickly on non-matching sites.
  // Failures are tolerated per source — a 404 sitemap shouldn't kill feed
  // discovery, and a non-WP site shouldn't block the Shopify probe.
  const [sitemapUrls, homepageLinks, navLinks, cmsApiResults] = await Promise.all([
    oobOrigin ? discoverSeedsFromOrigin(oobOrigin).catch(() => []) : Promise.resolve([]),
    oobOrigin ? discoverHomepageLinks(startUrl).catch(() => ({ hreflang: [], canonical: null, nextPrev: [], feeds: [] })) : Promise.resolve({ hreflang: [], canonical: null, nextPrev: [], feeds: [] }),
    // noScroll: true — the seed tab IS the user's visible tab. We already
    // captured the seed screenshot in its initial scroll position; scrolling
    // now would (a) visibly jerk the page up/down for 10-30s, (b) trigger
    // sticky-header / scroll-listener side effects that linger after restore.
    // Static-DOM nav harvest still runs; sitemap / hreflang / feed discovery
    // above cover the routes we'd otherwise have surfaced via scroll.
    collectNavLinks(tabId, { noScroll: true }).catch(() => []),
    // CMS / framework API probes — WordPress REST, Shopify products.json,
    // HTML sitemap pages, Next.js / Gatsby build manifests, JSON-LD URL
    // harvest from the seed HTML. Shares ONE seed-URL fetch across the
    // framework + JSON-LD probes, so HTTP cost is bounded.
    oobOrigin ? probeAllCmsApis(oobOrigin, startUrl).catch(() => ({
      wordpress: [], shopify: [], htmlSitemap: [], frameworkManifest: [], jsonLd: []
    })) : Promise.resolve({ wordpress: [], shopify: [], htmlSitemap: [], frameworkManifest: [], jsonLd: [] })
  ]);

  // Feed discovery depends on the homepage autodiscovery links, so it runs
  // after the first batch completes. Still cheap — only fires the HTTP
  // probes if we have an origin, and parseFeedEntries bails fast on HTML.
  const feedUrls = oobOrigin
    ? await discoverFeeds(oobOrigin, homepageLinks.feeds || []).catch(() => [])
    : [];

  const linkRelUrls = [];
  if (homepageLinks.canonical && homepageLinks.canonical !== startUrl) linkRelUrls.push(homepageLinks.canonical);
  for (const u of homepageLinks.nextPrev || []) linkRelUrls.push(u);

  const navOnly  = navLinks.filter(l => l.priority >= 10).map(l => l.url);
  const bodyOnly = navLinks.filter(l => l.priority <  10).map(l => l.url);

  // Enqueue in strict priority order. Each enqueueMany() stops adding once
  // the seen-set fills (queue.enqueue returns false past maxUrls), so the
  // first-in wins behaviour correctly biases the crawl.
  discoveryStats.nav      = queue.enqueueMany(navOnly,           { depth, priority: 8, source: "nav" });
  discoveryStats.linkRels = queue.enqueueMany(linkRelUrls,       { depth, priority: 7, source: "linkRel" });

  // CMS-API tier (priority 6) — structured-data sources that tend to be
  // comprehensive and high-signal. Recorded before hreflang so the raw
  // counts are visible even when the queue fills up and later sources
  // enqueue zero. We record both the raw count (how many the probe found)
  // and the enqueued count (how many actually made it into the queue), so
  // operators can see when probes are paying off even if the budget capped
  // their contribution.
  discoveryStats.cmsWordpressRaw = cmsApiResults.wordpress.length;
  discoveryStats.cmsWordpress = queue.enqueueMany(cmsApiResults.wordpress, {
    depth, priority: 6, source: "cms-wp"
  });
  discoveryStats.cmsShopifyRaw = cmsApiResults.shopify.length;
  discoveryStats.cmsShopify = queue.enqueueMany(cmsApiResults.shopify, {
    depth, priority: 6, source: "cms-shopify"
  });
  discoveryStats.htmlSitemapRaw = cmsApiResults.htmlSitemap.length;
  discoveryStats.htmlSitemap = queue.enqueueMany(cmsApiResults.htmlSitemap, {
    depth, priority: 6, source: "html-sitemap"
  });
  discoveryStats.frameworkManifestRaw = cmsApiResults.frameworkManifest.length;
  discoveryStats.frameworkManifest = queue.enqueueMany(cmsApiResults.frameworkManifest, {
    depth, priority: 6, source: "framework-manifest"
  });
  discoveryStats.jsonLdRaw = cmsApiResults.jsonLd.length;
  discoveryStats.jsonLd = queue.enqueueMany(cmsApiResults.jsonLd, {
    depth, priority: 6, source: "json-ld"
  });

  discoveryStats.hreflang = queue.enqueueMany(homepageLinks.hreflang || [], { depth, priority: 5, source: "hreflang" });

  // Compute remaining budget for the noisy sources (feed + sitemap). We
  // split the remaining slots roughly 30% to feeds (typically fresh /
  // chronological) and 70% to sitemap (typically complete site index),
  // with bucket-sampling on the sitemap so sections aren't starved.
  const remainingAfterHighPrio = Math.max(0, queue.maxUrls - queue.total);
  const feedBudget    = Math.min(feedUrls.length, Math.ceil(remainingAfterHighPrio * 0.3));
  const sitemapBudget = Math.max(0, remainingAfterHighPrio - feedBudget);

  discoveryStats.feedRaw = feedUrls.length;
  discoveryStats.feed = queue.enqueueMany(feedUrls.slice(0, Math.max(feedBudget, 0)), {
    depth, priority: 4, source: "feed"
  });

  discoveryStats.sitemapRaw = sitemapUrls.length;
  const sitemapSample = sampleByPathBucket(sitemapUrls, Math.max(sitemapBudget, 0));
  discoveryStats.sitemap = queue.enqueueMany(sitemapSample, { depth, priority: 3, source: "sitemap" });

  // Body-links fill whatever's left. These are low-signal but often the
  // only way to reach deep-linked detail pages on sites without sitemaps
  // (e.g. many SPAs that never wrote a sitemap.xml).
  discoveryStats.body = queue.enqueueMany(bodyOnly, { depth, priority: 2, source: "body" });

  // v0.4.4 — feed the broken-link detector. Seed-page links carry the real
  // source URL + anchor text; out-of-band sources get a pseudo-source label
  // so a stale sitemap/feed entry that 404s is traceable to where it came
  // from. Everything recorded here gets status-checked after the crawl,
  // even URLs the crawl budget never reached.
  if (onLinks) {
    try {
      onLinks(startUrl, navLinks);
      const label = (name, urls) => {
        if (urls && urls.length) onLinks(`(${name})`, urls.map(u => ({ url: u, text: "" })));
      };
      label("sitemap.xml", sitemapSample);
      label("feed", feedUrls.slice(0, Math.max(feedBudget, 0)));
      label("hreflang", homepageLinks.hreflang || []);
      label("link-rel", linkRelUrls);
      label("cms-api", [
        ...cmsApiResults.wordpress, ...cmsApiResults.shopify, ...cmsApiResults.htmlSitemap,
        ...cmsApiResults.frameworkManifest, ...cmsApiResults.jsonLd
      ]);
    } catch (err) {
      console.warn("[EU] onLinks recording failed:", err?.message || err);
    }
  }
}

// v0.4.8 — scanInNewTab (the lighter axe-only crawl worker) removed along
// with scanMulti. All crawl modes now use inventoryInNewTab, which runs the
// same audit stack plus template fingerprint / content signals / screenshots.

async function injectAxe(tabId) {
  // Inject axe-core + our custom check bundles together. They attach to
  // window.EU_IndiaChecks / window.EU_MediaChecks / window.EU_Is17802Checks
  // so the content-script can merge their output into the axe results +
  // the media inventory + the IS 17802 site-governance snapshot payload.
  //
  // Retry wrapper around executeScript. MV3 raises
  //   "Couldn't load preload assets: [object ProgressEvent]"
  // when the internal preload fetch races a tab state change — common when
  // the site redirects every URL to the same landing page (disclosure gate,
  // consent wall, login wall) so 50 concurrent workers settle on the same
  // URL at the same instant, OR when the SW is under eviction pressure,
  // OR when the tab is in back/forward cache. It's a transient that almost
  // always clears with a short pause and a retry. Final failure is re-thrown
  // so the caller can record an error row rather than silently losing the
  // page.
  const files = ["lib/axe.min.js", "lib/india-checks.js", "lib/media-checks.js", "lib/is17802-checks.js", "lib/visual-checks.js"];
  let lastErr;
  for (let attempt = 0; attempt < 3; attempt++) {
    try {
      await chrome.scripting.executeScript({
        target: { tabId, allFrames: false },
        files,
        world: "ISOLATED"
      });
      return;
    } catch (err) {
      lastErr = err;
      const msg = String(err?.message || err || "");
      // Preload / frame-removed / tab-closed — retry. Permission errors
      // (chrome://, restricted URLs) are terminal, skip retry.
      const transient =
        /preload assets|frame was removed|No tab with id|Cannot access contents|target is no longer in the tab/i.test(msg);
      const terminal =
        /Cannot access a chrome:\/\/|Cannot access contents of url "chrome/i.test(msg);
      if (terminal || !transient || attempt === 2) throw err;
      // Wait for tab to stabilise. First retry ~120ms, second ~360ms.
      await sleep(120 * Math.pow(3, attempt));
      // Bail if the tab is gone.
      try {
        await chrome.tabs.get(tabId);
      } catch {
        throw lastErr;
      }
    }
  }
  throw lastErr;
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
  const bucket = n => n === 0 ? "0" : n === 1 ? "1" : n <= 5 ? "few" : n <= 20 ? "many" : "mass";
  const depthBucket = d => d <= 2 ? "shallow" : d <= 5 ? "mid" : d <= 9 ? "deep" : "vdeep";
  const depthOf = (node) => {
    let d = 0, cur = node;
    while (cur && cur.parentNode) {
      cur = cur.parentNode.host ? cur.parentNode.host : cur.parentNode;
      d++;
      if (d > 200) break;
    }
    return d;
  };
  const sig = [];
  const landmarkTags = ["header","nav","main","article","aside","footer","section","form","dialog","details","summary","figure","figcaption","table","thead","tbody","tfoot","h1","h2","h3","h4","h5","h6"];
  for (const tag of landmarkTags) {
    for (const el of qsaDeep(tag)) {
      const d = depthBucket(depthOf(el));
      const k = bucket(el.children ? el.children.length : 0);
      sig.push(`${el.tagName.toLowerCase()}:${el.getAttribute("role")||""}:${firstClasses(el,3)}:d=${d}:k=${k}`);
    }
  }
  for (const el of qsaDeep("[role]")) {
    const d = depthBucket(depthOf(el));
    sig.push(`${el.tagName.toLowerCase()}:${el.getAttribute("role")||""}:${firstClasses(el,3)}:d=${d}`);
  }
  const hCounts = [1,2,3,4,5,6].map(n => qsaDeep(`h${n}`).length);
  sig.push("H:" + hCounts.join("-"));
  const LAYOUT = ["layout","template","container","wrapper","grid","flex","row","col-","block","module","widget","component","page-","content"];
  const seen = new Set();
  for (const p of LAYOUT) {
    for (const el of qsaDeep(`[class*="${p}" i]`)) {
      const k = `${el.tagName.toLowerCase()}::${firstClasses(el,3)}:k=${bucket(el.children?el.children.length:0)}`;
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
      // Hand the operator-selected WCAG tag set to the page in the same
      // ISOLATED world the content script reads from, so axe runs the chosen
      // version. Best-effort — on failure content-script.js falls back to its
      // built-in WCAG 2.1 A+AA default.
      try {
        await chrome.scripting.executeScript({
          target: { tabId, allFrames: false },
          world: "ISOLATED",
          func: (opts) => { window.__EU_SCAN_OPTS = opts; },
          args: [{ axeTags: ACTIVE_AXE_TAGS, checks: ACTIVE_CHECKS, dismissOverlays: ACTIVE_DISMISS, auditBoth: ACTIVE_AUDIT_BOTH }]
        });
      } catch (e) { /* fall back to content-script default */ }
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

// Media & document inventory — one flat row per item detected across the
// corpus, plus corpus-level summary counts. v0.4.8 — extracted from
// buildReport so buildInventory can produce the same mediaRows shape (which
// the PDF / Office structural-audit enrichers and the classic report's
// Media & Documents section both consume).
function collectMediaRows(pages) {
  const mediaRows = [];
  const mediaSummary = {
    videos: 0, audios: 0, iframeVideos: 0, documents: 0,
    pdf: 0, spreadsheet: 0, document: 0, presentation: 0,
    videoIssues: 0, audioIssues: 0, iframeIssues: 0, documentIssues: 0
  };

  for (const p of pages) {
    const pageUrl = p.url;
    // Keeps the per-item issue list (as emitted by media-checks.js) so the
    // renderer can group findings under the item and the CSV can expose
    // them as a pipe list.
    const mi = p.mediaInventory;
    if (!mi || typeof mi !== "object") continue;
    const pushItem = (kindKey, it, extras) => {
      mediaSummary[kindKey]++;
      mediaSummary[`${kindKey === "iframeVideos" ? "iframe" : kindKey === "videos" ? "video" : kindKey === "audios" ? "audio" : "document"}Issues`] += (it.issues || []).length;
      mediaRows.push({
        url: pageUrl,
        page_title: p.title || "",
        kind: extras.kind,
        subtype: it.subtype || "",
        type_label: extras.typeLabel,
        family: it.family || "",
        media_url: it.url || "",
        accessible_name: it.accessibleName || "",
        link_text: it.linkText || "",
        context: it.context || "",
        selector: it.selector || "",
        has_captions: it.hasCaptions ?? "",
        has_descriptions: it.hasDescriptions ?? "",
        has_controls: it.hasControls ?? "",
        autoplay: it.autoplay ?? "",
        muted: it.muted ?? "",
        has_transcript: it.hasTranscript ?? "",
        has_type_hint: it.hasTypeHint ?? "",
        has_size_hint: it.hasSizeHint ?? "",
        opens_in_new_tab: it.opensInNewTab ?? "",
        has_new_tab_notice: it.hasNewTabNotice ?? "",
        title_attr: it.title || it.titleAttr || "",
        aria_label: it.ariaLabel || "",
        duration_seconds: it.durationSeconds ?? "",
        vendor_label: it.vendorLabel || "",
        tracks: it.tracks || [],
        issues: it.issues || [],
        issue_count: (it.issues || []).length,
        html_snippet: it.html || ""
      });
    };
    for (const v of mi.videos || []) {
      pushItem("videos", v, { kind: "video", typeLabel: "HTML5 Video" });
    }
    for (const a of mi.audios || []) {
      pushItem("audios", a, { kind: "audio", typeLabel: "HTML5 Audio" });
    }
    for (const f of mi.iframeVideos || []) {
      pushItem("iframeVideos", f, { kind: "iframe-video", typeLabel: f.vendorLabel || "Embedded Video" });
    }
    for (const d of mi.documents || []) {
      pushItem("documents", d, { kind: "document", typeLabel: d.typeLabel || d.subtype || "Document" });
      // Per-family rollup count so the summary tile can show "12 PDFs, 3 Excels".
      const fam = d.family || "document";
      if (mediaSummary[fam] != null) mediaSummary[fam]++;
    }
  }

  return { mediaRows, mediaSummary };
}

function buildReport(pages, meta) {
  const issueRows = [];
  const passRows = [];
  const incompleteRows = [];
  const inapplicableRows = [];
  const checkRows = [];   // one row per {node × check-slot × check} — the deepest detail
  const envRows = [];     // per-page axe test engine / environment / toolOptions
  const { mediaRows, mediaSummary } = collectMediaRows(pages);

  // Criterion scope is driven by the selected profile / WCAG version, so the
  // summary + per-profile conformance tables reflect exactly the SCs actually
  // tested (WCAG 2.2 adds e.g. 2.5.8 Target Size and drops 4.1.1 Parsing;
  // Section 508 restricts to the WCAG 2.0 subset).
  const profileKey = (meta && meta.profile && PROFILES[meta.profile]) ? meta.profile : "wcag21aa";
  const reportCriteria = criteriaForProfile(profileKey)
    .map(num => CRITERION_BY_NUM[num])
    .filter(Boolean);

  const criterionStats = new Map();
  for (const c of reportCriteria) {
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
      // Custom rules (india-checks / is17802-checks / media-checks) may not carry wcagXXX tags
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
            is17802_clause:   xref?.is17802    || "",
            en301549_clause:  xref?.en301549   || "",
            section508_ref:   xref?.section508 || "",
            ada_ref:          xref?.ada        || "",
            rule_id: v.ruleId,
            rule_impact: v.impact || "",
            rule_description: v.description || "",
            rule_help: v.help || "",
            rule_tags: (v.tags || []).join(" "),
            rule_source: v.ruleId && (v.ruleId.startsWith("india-") || v.ruleId.startsWith("media-") || v.ruleId.startsWith("is17802-")) ? "custom" : "axe-core",
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

    for (const c of reportCriteria) {
      if (!failed.has(c.num)) {
        const st = criterionStats.get(c.num);
        if (st && !p.error) st.pagesPassed.add(pageUrl);
      }
    }
  }

  const summaryRows = reportCriteria.map(c => {
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
    // v0.4.0 team-merge — DOM simhash in the multi-page audit CSV export.
    dom_hash: p.template?.domHash || "",
    dom_preview: p.template?.domPreview || "",
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
  // For each compliance profile (WCAG 2.1 AA, IS 17802, EN 301 549,
  // Section 508, ADA), compute: which in-scope SCs have failures across the
  // corpus. Produces a compact table the report can render as "Conformance
  // by Standard" and the ACR / VPAT generator can consume directly.
  const profilesRows = PROFILE_KEYS.map(key => {
    const p = PROFILES[key];
    let applicable = 0, failed = 0, passed = 0, violations = 0;
    const failingClauses = [];
    for (const c of reportCriteria) {
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
    meta: { ...meta, generatedAt: new Date().toISOString(), totalPages: pages.length, totalTemplates: templatesRows.length, profileLabel: (PROFILES[profileKey] && PROFILES[profileKey].label) || "WCAG 2.1 AA", wcagVersion: versionForProfile(profileKey) },
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
    mediaRows,
    mediaSummary,
    pages
  };
}

function sumNodes(rules) {
  let n = 0;
  for (const r of rules || []) n += (r.nodes || []).length;
  return n;
}

async function downloadReportXlsx(reportId) {
  const report = await getReport(reportId);
  if (!report) return { ok: false, error: "Report not found — it was pruned (only the last 5 are kept) or storage was cleared. Run a new scan." };
  const blob = await buildReportXlsx(report);
  const dataUrl = await blobToDataUrl(blob);
  const host = safeHost(report.meta.seedUrl);
  const stamp = report.meta.generatedAt.replace(/[:.]/g, "-");
  await chrome.downloads.download({
    url: dataUrl,
    filename: `enableuser-report-${host}-${stamp}.xlsx`,
    saveAs: false
  });
  return { ok: true };
}

async function downloadCsv(reportId) {
  const report = await getReport(reportId);
  if (!report) return { ok: false, error: "Report not found — it was pruned (only the last 5 are kept) or storage was cleared. Run a new scan." };

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
    "is17802_clause", "en301549_clause", "section508_ref", "ada_ref",
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
    "template_id", "url_cluster", "text_hash", "dom_hash", "dom_preview",
    "text_length", "signature_items",
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

  const mediaCols = [
    "url", "page_title", "kind", "subtype", "type_label", "family",
    "media_url", "accessible_name", "link_text", "context",
    "has_captions", "has_descriptions", "has_controls", "autoplay", "muted",
    "has_transcript", "has_type_hint", "has_size_hint",
    "opens_in_new_tab", "has_new_tab_notice",
    "title_attr", "aria_label", "duration_seconds", "vendor_label",
    "tracks", "issues", "issue_count", "selector", "html_snippet",
    // v13.1 PDF structural audit columns — only populated for PDF rows.
    "pdfAudit"
  ];
  const mediaCsv = toCsv(mediaCols, flatten(report.mediaRows || [], mediaCols));

  const combined =
    `# EnableUser Accessibility Report\r\n` +
    `# Generated: ${report.meta.generatedAt}\r\n` +
    `# Seed URL: ${report.meta.seedUrl}\r\n` +
    `# Mode: ${report.meta.mode}\r\n` +
    `# Pages scanned: ${report.meta.totalPages}\r\n` +
    `# Templates detected: ${report.meta.totalTemplates ?? 0}\r\n` +
    (report.meta.discoveryStats
      ? `# Discovery: nav=${report.meta.discoveryStats.nav} linkRels=${report.meta.discoveryStats.linkRels ?? 0} hreflang=${report.meta.discoveryStats.hreflang} feed=${report.meta.discoveryStats.feed ?? 0}/${report.meta.discoveryStats.feedRaw ?? 0} sitemap=${report.meta.discoveryStats.sitemap}/${report.meta.discoveryStats.sitemapRaw ?? 0} body=${report.meta.discoveryStats.body}\r\n`
      : ``) +
    `\r\n## ${report.meta.profileLabel || "WCAG 2.1 AA"} — Criterion Summary\r\n` + summaryCsv +
    `\r\n\r\n## Conformance by Standard (WCAG / IS 17802 / EN 301 549 / Section 508 / ADA)\r\n` + profilesCsv +
    `\r\n\r\n## Templates\r\n` + templatesCsv +
    `\r\n\r\n## Violations (one row per violation × WCAG criterion × node)\r\n` + issuesCsv +
    `\r\n\r\n## Passes (one row per node)\r\n` + passesCsv +
    `\r\n\r\n## Incomplete (one row per node)\r\n` + incompleteCsv +
    `\r\n\r\n## Inapplicable (one row per rule)\r\n` + inapplicableCsv +
    `\r\n\r\n## Check Details (one row per any/all/none check per node, all categories)\r\n` + checksCsv +
    `\r\n\r\n## Pages\r\n` + pagesCsv +
    `\r\n\r\n## Media & Documents (one row per video / audio / embedded player / linked document)\r\n` + mediaCsv +
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

// ─────────────────────────────────────────────────────────────────────────
// v0.4.3 — dedicated crawler window (ported from SiteCrawler v1.1.0).
// Worker tabs open in a separate minimized window instead of the user's
// own window, so a 200-tab crawl doesn't flood their tab strip. If window
// creation fails, or the user closes the crawler window mid-crawl, we fall
// back to plain tabs in the current window — the crawl never dies over it.
// ─────────────────────────────────────────────────────────────────────────
let _crawlerWindowId = null;

chrome.windows.onRemoved.addListener((winId) => {
  if (winId === _crawlerWindowId) _crawlerWindowId = null;
});

async function openCrawlerWindow() {
  try {
    const win = await chrome.windows.create({ url: "about:blank", focused: false, state: "minimized" });
    _crawlerWindowId = win.id;
    console.log(`[EU] crawler window opened (id=${win.id})`);
  } catch (err) {
    _crawlerWindowId = null;
    console.warn("[EU] crawler window creation failed — worker tabs will open in the current window:", err?.message || err);
  }
}

async function closeCrawlerWindow() {
  if (_crawlerWindowId == null) return;
  const id = _crawlerWindowId;
  _crawlerWindowId = null;
  try { await chrome.windows.remove(id); } catch {}
}

async function createWorkerTab(url) {
  if (_crawlerWindowId != null) {
    try {
      return await chrome.tabs.create({ windowId: _crawlerWindowId, url, active: false });
    } catch {
      _crawlerWindowId = null; // window vanished — fall through
    }
  }
  return chrome.tabs.create({ url, active: false });
}

// ─────────────────────────────────────────────────────────────────────────
// v0.4.3 — mid-crawl checkpoint (ported from SiteCrawler v1.1.0's
// persist-every-N-results). Screenshots are stripped: the blobs live in an
// in-memory map that wouldn't survive the crash anyway, and including them
// would make every checkpoint write enormous.
// ─────────────────────────────────────────────────────────────────────────
const CHECKPOINT_KEY = "eu-crawl-checkpoint";

function checkpointCrawl(pages, meta) {
  const lite = pages.map(p => ({ ...p, screenshot: null }));
  chrome.storage.local.set({
    [CHECKPOINT_KEY]: { ...meta, updatedAt: Date.now(), pages: lite }
  }).catch(err => console.warn("[EU] checkpoint write failed:", err?.message || err));
}

function clearCheckpoint() {
  chrome.storage.local.remove(CHECKPOINT_KEY).catch(() => {});
}

// Rebuild an inventory report from the last mid-crawl checkpoint. Invoked
// from the popup's "Recover interrupted crawl" button after a crash.
async function recoverCheckpoint() {
  const got = await chrome.storage.local.get(CHECKPOINT_KEY);
  const cp = got?.[CHECKPOINT_KEY];
  if (!cp || !Array.isArray(cp.pages) || cp.pages.length === 0) {
    return { ok: false, error: "no recoverable crawl found" };
  }
  const inventory = buildInventory(cp.pages, {
    seedUrl: cp.seedUrl, seedHost: cp.seedHost, maxUrls: cp.maxUrls,
    crawlDepth: cp.crawlDepth, depthStats: cp.depthStats || {},
    profile: cp.profile, recovered: true
  });
  const inventoryId = `inv-${Date.now()}`;
  inventories.set(inventoryId, { inventory, files: {} });
  try { await persistInventory(inventoryId, inventory); }
  catch (err) { console.warn("[EU] persistInventory (recovery) failed", err); }
  await chrome.tabs.create({ url: chrome.runtime.getURL(`report/inventory.html?id=${inventoryId}`) });
  clearCheckpoint();
  return { ok: true, inventoryId, recoveredPages: cp.pages.length };
}

// v0.4.2 — adaptive DOM-quiet settle (ported from SiteCrawler v1.1.0).
// Injected into the page: resolves once the DOM has stopped mutating for
// SETTLE_QUIET_MS, but never before SETTLE_MIN_MS and never after
// SETTLE_MAX_MS. Replaces the old fixed sleep(SETTLE_MS = 15s). If the
// injection itself fails (tab navigated to an error page, frame removed,
// restricted URL) we fall back to sleeping out the full max window so
// behaviour is never worse than a fixed wait.
async function adaptiveSettle(tabId) {
  try {
    await chrome.scripting.executeScript({
      target: { tabId },
      func: (minMs, quietMs, maxMs) => new Promise(resolve => {
        const start = Date.now();
        let lastMutation = start;
        let obs = null;
        try {
          obs = new MutationObserver(() => { lastMutation = Date.now(); });
          obs.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
        } catch { /* observer refused — the min/max timers below still apply */ }
        const finish = () => { try { obs && obs.disconnect(); } catch {} resolve(); };
        (function tick() {
          const now = Date.now();
          if (now - start >= maxMs) return finish();
          if (now - start >= minMs && now - lastMutation >= quietMs) return finish();
          setTimeout(tick, 150);
        })();
      }),
      args: [SETTLE_MIN_MS, SETTLE_QUIET_MS, SETTLE_MAX_MS]
    });
  } catch (err) {
    console.warn(`[EU] adaptiveSettle injection failed (tab ${tabId}), falling back to fixed ${SETTLE_MAX_MS}ms:`, err?.message || err);
    await sleep(SETTLE_MAX_MS);
  }
}
function safeOrigin(u) { try { return new URL(u).origin; } catch { return null; } }

// Poll chrome.tabs.get() until the tab's URL has been stable for two
// consecutive reads. Callers use this AFTER waitForTabComplete + adaptiveSettle,
// to catch late JavaScript-based redirects (e.g. disclosure gates that
// check a session cookie client-side and navigate via `location.href`).
// Returns the stable URL, or null if the tab went away.
async function waitForUrlSettle(tabId, { maxMs = 2000, pollMs = 250 } = {}) {
  let last;
  try { last = (await chrome.tabs.get(tabId))?.url || null; } catch { return null; }
  const start = Date.now();
  while (Date.now() - start < maxMs) {
    await sleep(pollMs);
    let cur;
    try { cur = (await chrome.tabs.get(tabId))?.url || null; } catch { return last; }
    if (cur === last) return cur;
    last = cur;
  }
  return last;
}

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
