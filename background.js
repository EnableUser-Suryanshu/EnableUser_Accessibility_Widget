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
  discoverHomepageLinks,
  discoverFeeds,
  sampleByPathBucket,
  navSurfacedCollect
} from "./lib/discovery.js";
import { buildScopeDocx } from "./lib/docx-writer.js";
import { buildInventoryXlsx, buildClustersXlsx, buildAuditXlsx } from "./lib/xlsx-writer.js";
import { classifyTemplate, templateSlugKey } from "./lib/template-classifier.js";

const DEFAULT_MAX_URLS = 50;
const DEFAULT_CRAWL_DEPTH = 1;
// Intentionally NO HARD_MAX_URLS ceiling. The user's explicit direction: a
// professional audit tool doesn't impose arbitrary limits on the operator.
// We floor at 1 to prevent a zero-URL crawl, and let the operator set any
// upper number they're willing to wait for. Concurrency + rate-limiter keep
// the target site safe regardless of total URL count.
// CONCURRENT_TABS governs how many tabs run axe in parallel. Each tab
// spins up its own Chromium renderer + axe context so memory cost is
// real (~100–200 MB per tab on content-heavy pages). At 200 tabs that's
// roughly 20–40 GB of RAM at peak — the operator set this explicitly
// ("open 200 tabs at once") so a large site finishes in a small number
// of concurrent waves. The RateLimiter still governs per-site pacing
// (backoff on 429/503, same-host politeness) and the injectAxe retry
// wrapper (see lower in file) handles the preload-race the 200-way
// concurrency will trigger more often.
//
// SETTLE_MS is the wait between "tab reported navigation complete" and
// (a) the settled-URL dedup check, (b) axe injection, (c) the full-page
// screenshot. 15 s gives cookie-consent banners, GDPR popups, lazy-
// loaded images, animations, and any client-side redirect JS enough time
// to fully settle before we take the audit and the screenshot. Shorter
// waits caused screenshots to miss below-the-fold content that hadn't
// yet intersection-observer-triggered a lazy load.
const CONCURRENT_TABS = 200;
const TAB_TIMEOUT_MS = 60_000;
const SETTLE_MS = 15_000;
// Per-origin concurrency cap. CONCURRENT_TABS=200 is a GLOBAL worker count;
// on a single-origin crawl (e.g. one 160-page marketing site) all 200
// workers slam the same host, the target server's per-IP rate limit trips,
// Chrome's renderer pool saturates, and tabs start failing with "frame
// was removed" / "Cannot access contents" before axe ever runs. PER_ORIGIN_TABS
// caps the host-level parallelism; on a multi-site crawl the global 200 is
// still reachable (e.g. 25 origins × 8 tabs each).
const PER_ORIGIN_TABS = 8;

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
      else if (msg.type === "SCAN_MULTI") sendResponse(await scanMulti(msg.tabId, msg.options));
      else if (msg.type === "SCAN_INVENTORY") sendResponse(await scanInventory(msg.tabId, msg.options));
      else if (msg.type === "SCAN_LIST") sendResponse(await scanList(msg.options));
      else if (msg.type === "SCAN_RESULT") sendResponse(handleResult(msg.payload, sender));
      else if (msg.type === "SCAN_ERROR") sendResponse(handleError(msg.payload, sender));
      else if (msg.type === "GET_REPORT") sendResponse({ ok: true, report: reports.get(msg.reportId) || null });
      else if (msg.type === "GET_INVENTORY") sendResponse(await getInventory(msg.inventoryId));
      else if (msg.type === "GET_SCREENSHOT") sendResponse(await getScreenshot(msg.id));
      else if (msg.type === "DOWNLOAD_CSV") sendResponse(await downloadCsv(msg.reportId));
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
  const result = await scanInExistingTab(tabId);
  const profile = (options?.profile && PROFILES[options.profile]) ? options.profile : "wcag21aa";
  const report = buildReport([{ url: tab.url, title: tab.title, ...result }], { mode: "single", seedUrl: tab.url, profile });
  const reportId = `r-${Date.now()}`;
  reports.set(reportId, report);
  await chrome.tabs.create({ url: chrome.runtime.getURL(`report/report.html?id=${reportId}`) });
  return { ok: true, reportId };
}

async function scanMulti(tabId, options) {
  // No arbitrary upper cap on maxUrls — operator decides. Floor of 1.
  const maxUrls = floorInt(options?.maxUrls, DEFAULT_MAX_URLS, 1);
  // v11: depth unbounded by default, matching scanInventory. The priority
  // queue naturally biases shallower pages first, so unbounded depth just
  // means "keep expanding the frontier until maxUrls fills or it empties".
  // A user-supplied crawlDepth > 0 is still honoured exactly for operators
  // who deliberately want to short-circuit a deep site.
  const rawDepth = parseInt(options?.crawlDepth, 10);
  const crawlDepth = (Number.isFinite(rawDepth) && rawDepth > 0)
    ? rawDepth
    : Number.POSITIVE_INFINITY;
  const profile = (options?.profile && PROFILES[options.profile]) ? options.profile : "wcag21aa";

  const tab = await chrome.tabs.get(tabId);
  const startUrl = tab.url;
  const seedOrigin = safeOrigin(startUrl);

  const queue = new RequestQueue({ scopeUrl: startUrl, maxUrls, maxDepth: crawlDepth, scope: "same-hostname" });
  queue.enqueue(startUrl, { depth: 0, priority: 100, source: "seed" });
  queue.markSettled(startUrl);

  const results = [];
  const depthStats = {};
  const discoveryStats = {
    nav: 0, body: 0, sitemap: 0, hreflang: 0, feed: 0, linkRels: 0,
    sitemapRaw: 0, feedRaw: 0, commonPaths: 0
  };

  queue.next();
  depthStats[0] = 1;
  const startScan = await scanInExistingTab(tabId);
  results.push({ url: startUrl, title: tab.title, depth: 0, source: "seed", ...startScan });

  // Seed tab may have redirected during the scan. Mark the current URL as
  // settled so workers dedup against it.
  try {
    const liveSeed = await chrome.tabs.get(tabId);
    if (liveSeed?.url) queue.markSettled(liveSeed.url);
  } catch {}

  await seedDiscovery({
    tabId, startUrl, seedOrigin, queue, depth: 1, discoveryStats
  });

  console.log(`[EU] discovery — nav:${discoveryStats.nav} body:${discoveryStats.body} sitemap:${discoveryStats.sitemap}/${discoveryStats.sitemapRaw} hreflang:${discoveryStats.hreflang} feed:${discoveryStats.feed}/${discoveryStats.feedRaw} linkRels:${discoveryStats.linkRels} | pending:${queue.pending}`);

  const active = new Set();

  async function launch(req) {
    // `acquired` tracks whether wait() returned a non-null token. Only if
    // it did do we need to call release() — a null return means the URL
    // was unparseable and no semaphore slot was taken. We call release()
    // in a finally so the slot is freed even if reportSuccess/reportFailure
    // or the scan work throws. Missing a release leaks the slot and
    // eventually stalls the origin (workers stuck waiting for a slot that
    // will never free).
    let acquired = false;
    try {
      const token = await rateLimiter.wait(req.url);
      acquired = token != null;
      const r = await scanInNewTab(req.url, req.depth < crawlDepth, { queue });
      rateLimiter.reportSuccess(req.url);

      // Settled-URL dedup: tab landed on a URL another worker already scanned.
      if (r.__skipped === "redirect-to-duplicate") {
        results.push({
          url: req.url, depth: req.depth, source: req.source,
          error: `redirected to already-scanned URL: ${r.settledUrl}`,
          violations: [], passes: [], incomplete: [], inapplicable: []
        });
        depthStats[req.depth] = (depthStats[req.depth] || 0) + 1;
        return;
      }

      const { links = [], ...scan } = r;
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
    } finally {
      if (acquired) rateLimiter.release(req.url);
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

  console.log(`[EU] inventory scan start — seed=${startUrl} maxUrls=${maxUrls} depth=${crawlDepth}`);

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

  // Seed page runs the SAME full audit stack as every other crawled URL —
  // axe + india + gigw + content-signals + full-page screenshot. Runs in the
  // existing tab (no new tab open) so the user's session/cookies/scroll
  // state is preserved for the seed.
  queue.next();
  depthStats[0] = 1;
  try {
    await injectAxe(tabId);
    const auditPayload = await runContentScan(tabId);
    const signals = await collectContentSignals(tabId);
    let screenshot = null;
    try { screenshot = await captureFullPageScreenshot(tabId); }
    catch (err) { console.warn(`[EU] seed screenshot failed:`, err?.message || err); }
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
      element_counts: tmpl.elementCounts || {},
      audit: {
        scanStartedAt: auditPayload?.scanStartedAt || null,
        scanDurationMs: auditPayload?.scanDurationMs || 0,
        testEngine: auditPayload?.testEngine || null,
        violations: auditPayload?.violations || [],
        passes: auditPayload?.passes || [],
        incomplete: auditPayload?.incomplete || [],
        inapplicable: auditPayload?.inapplicable || []
      },
      screenshot,
      ...seedSignals
    });
  } catch (err) {
    pages.push({ url: startUrl, depth: 0, source: "seed", error: String(err?.message || err) });
  }
  // Seed page is done — tick progress. "done" counts every finished URL
  // whether the fetch succeeded or errored, because the operator cares about
  // completion state, not just successes.
  await progressUpdate({ done: pages.length, currentUrl: startUrl });

  // Same discovery pipeline as scanMulti — seedDiscovery() runs sitemap,
  // homepage <link rel=…>, RSS/Atom feeds, and in-page nav harvest in
  // parallel and enqueues them in priority order (nav > canonical/next/prev
  // > hreflang > feed > sitemap > body) so limited-budget crawls don't get
  // starved by a 10k-entry sitemap dumped first.
  await seedDiscovery({
    tabId, startUrl, seedOrigin, queue, depth: 1,
    discoveryStats: { nav: 0, body: 0, sitemap: 0, hreflang: 0, feed: 0, linkRels: 0, sitemapRaw: 0, feedRaw: 0 }
  });

  console.log(`[EU] post-discovery queue size: ${queue.pending} pending, ${queue.total} total seen`);

  const active = new Set();

  async function launch(req) {
    console.log(`[EU] launch: ${req.url} (source=${req.source}, depth=${req.depth})`);
    // See comment on the audit-mode launch above for why `acquired` is
    // tracked and why release() lives in a finally block. Short version:
    // semaphore slots MUST be freed on every exit path or the origin stalls.
    let acquired = false;
    try {
      const token = await rateLimiter.wait(req.url);
      acquired = token != null;
      const result = await inventoryInNewTab(req.url, req.depth < crawlDepth, { queue });
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
      if (req.depth < crawlDepth) {
        const nav = links.filter(l => l.priority >= 10).map(l => l.url);
        const body = links.filter(l => l.priority < 10).map(l => l.url);
        queue.enqueueMany(nav, { depth: req.depth + 1, priority: 8, source: "nav" });
        queue.enqueueMany(body, { depth: req.depth + 1, priority: 2, source: "body" });
      }
    } catch (err) {
      rateLimiter.reportFailure(req.url, { status: err?.status || 0 });
      pages.push({ url: req.url, depth: req.depth, source: req.source, error: String(err?.message || err) });
    } finally {
      if (acquired) rateLimiter.release(req.url);
    }
    // Progress tick after every launched URL (success or error). Don't
    // await — fire-and-forget so a slow chrome.storage write can't block
    // the next tab from launching. Popup polls via storage.onChanged.
    progressUpdate({ done: pages.length, currentUrl: req.url });
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

  // Mark the crawl as inactive so the popup's progress banner disappears.
  // Keep the final done/total for one refresh so the user sees "done" before
  // it clears.
  await progressUpdate({ active: false, currentUrl: "", completedAt: Date.now(), done: pages.length });

  const profile = (options?.profile && PROFILES[options.profile]) ? options.profile : "wcag21aa";
  const inventory = buildInventory(pages, { seedUrl: startUrl, seedHost, maxUrls, crawlDepth, depthStats, profile });
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
  return { ok: true, inventoryId };
}

// Fire-and-forget persistence. One chrome.storage.local.set call containing
// the inventory payload + every screenshot it references.
async function persistInventory(inventoryId, inventory) {
  const record = { [`inv:${inventoryId}`]: inventory };
  const seen = new Set();
  const collect = (shot) => {
    if (!shot?.id || seen.has(shot.id)) return;
    const entry = inventoryScreenshots.get(shot.id);
    if (entry) {
      record[`shot:${shot.id}`] = entry;
      seen.add(shot.id);
    }
  };
  for (const p of inventory.pages || []) collect(p.screenshot);
  for (const t of inventory.templates || []) collect(t.sample_screenshot);
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
    } catch (err) {
      rateLimiter.reportFailure(url, { status: err?.status || 0 });
      console.warn(`[EU] template-check failed: ${url}`, err?.message || err);
      pages.push({ url, depth: 0, source: "pasted", error: String(err?.message || err) });
    } finally {
      if (acquired) rateLimiter.release(url);
    }
    progressUpdate({ done: pages.length, currentUrl: url });
  }

  function pump() {
    while (active.size < CONCURRENT_TABS && toScan.length > 0) {
      const url = toScan.shift();
      const p = launch(url).finally(() => active.delete(p));
      active.add(p);
    }
  }
  pump();
  while (active.size > 0) { await Promise.race(active); pump(); }

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
    noDedup: true
  });
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
// gigw) + content-signals + full-page screenshot. The result is a complete
// per-page record: violations/passes/incomplete/inapplicable, template
// fingerprint, content-type flags, actual component values, and a PNG
// screenshot blob. This replaces the earlier signals-only path on user
// direction — inventory mode IS the full audit, not a lightweight preview.
async function inventoryInNewTab(url, collectNextLinks, { queue = null } = {}) {
  const tab = await chrome.tabs.create({ url, active: false });
  const tabId = tab.id;
  try {
    await waitForTabComplete(tabId, TAB_TIMEOUT_MS);
    await sleep(SETTLE_MS);

    // Settled-URL dedup — MUST come after SETTLE_MS. waitForTabComplete
    // resolves on the initial URL's "complete" state, but JavaScript-based
    // redirects (typical of disclosure-gate / age-gate / session-wall sites)
    // fire AFTER complete, so we have to give them SETTLE_MS to run. We
    // also poll briefly once more to catch late redirects.
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

    // Full audit stack — same code path as scanMulti.
    await injectAxe(tabId);
    const auditPayload = await runContentScan(tabId);

    // Content signals (with shadow DOM, actual values, static/dynamic class).
    const signals = await collectContentSignals(tabId);

    // Full-page screenshot via chrome.debugger. Falls back gracefully to
    // visible-viewport capture if debugger attach is refused (e.g. DevTools
    // already open on this tab, chrome:// URL, policy).
    let screenshot = null;
    try {
      screenshot = await captureFullPageScreenshot(tabId);
    } catch (err) {
      console.warn(`[EU] screenshot failed for ${url}:`, err?.message || err);
    }

    const tmpl = auditPayload?.template || {};
    const out = {
      title: auditPayload?.title || tab.title || "",
      template_id: tmpl.fingerprint || "unknown",
      url_cluster: tmpl.urlCluster || "unknown",
      text_hash: tmpl.textHash || "",
      element_counts: tmpl.elementCounts || {},
      // Full audit — same shape as multi-page mode.
      audit: {
        scanStartedAt: auditPayload?.scanStartedAt || null,
        scanDurationMs: auditPayload?.scanDurationMs || 0,
        testEngine: auditPayload?.testEngine || null,
        violations: auditPayload?.violations || [],
        passes: auditPayload?.passes || [],
        incomplete: auditPayload?.incomplete || [],
        inapplicable: auditPayload?.inapplicable || []
      },
      screenshot, // { dataUrl, width, height } | null
      ...signals
    };
    if (collectNextLinks) {
      try { out.links = await collectNavLinks(tabId); } catch { out.links = []; }
    }
    return out;
  } finally {
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
async function captureFullPageScreenshot(tabId) {
  const target = { tabId };
  await chrome.debugger.attach(target, "1.3");
  try {
    await chrome.debugger.sendCommand(target, "Page.enable");
    const result = await chrome.debugger.sendCommand(target, "Page.captureScreenshot", {
      format: "png",
      captureBeyondViewport: true,
      fromSurface: true
    });
    if (!result?.data) return null;
    const id = `shot-${crypto.randomUUID()}`;
    const dataUrl = `data:image/png;base64,${result.data}`;
    const bytes = result.data.length;
    inventoryScreenshots.set(id, { dataUrl, bytes });
    return { id, bytes };
  } finally {
    try { await chrome.debugger.detach(target); } catch {}
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
    for (const p of pages) {
      if (p.error) { realPagesRaw.push(p); continue; }
      if (p === seedPage) { realPagesRaw.push(p); continue; }
      const isShell =
        seedFp && p.template_id === seedFp &&
        seedTextHash && p.text_hash === seedTextHash;
      if (isShell) {
        p.isShell = true;
        shellPages.push(p);
      } else {
        realPagesRaw.push(p);
      }
    }
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
    return p.canonicalUrl || p.finalUrl || p.url || `__noid`;
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
      // If this visit scored higher, promote it and push the previous into alt
      if (scoreRecord(p) > scoreRecord(existing.record)) {
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
  const shellSummary = shellPages.length ? {
    count: shellPages.length,
    sample_urls: shellPages.slice(0, 20).map(p => p.url),
    explanation: "These URLs were crawled but returned the same DOM + text as the seed page. On SPAs this usually means the client router matched them to the default/home route (soft-404). Excluded from the main pages + templates tables so they don't inflate inventory counts."
  } : null;

  return {
    meta: {
      ...meta,
      crawlDepthLabel: Number.isFinite(meta.crawlDepth) ? String(meta.crawlDepth) : "unbounded",
      generatedAt: new Date().toISOString()
    },
    // `pages` is the real set (shell pages excluded). Keep shellPages
    // addressable separately so nothing is silently dropped.
    pages: realPages,
    shellPages,
    shellSummary,
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
  const pages = (inventory?.pages || []).filter(p => !p.error && p.screenshot?.id);
  if (!pages.length) return null;

  const out = new Map();
  const seen = new Set();
  const MAX_W = 300;
  const MAX_H = 400;

  for (const p of pages) {
    const id = p.screenshot.id;
    if (seen.has(id)) continue;
    seen.add(id);

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

// ─────────────────────────────────────────────────────────────────────────
// seedDiscovery — runs every discovery source in parallel then enqueues
// candidates in strict priority order so a single noisy source (typically
// sitemap with thousands of entries) can't starve higher-value sources
// (nav, hreflang, rel=next/prev) when maxUrls is tight.
//
// Priority ladder (higher = enqueued first):
//   nav         8   ← from the rendered seed page, navSurfacedCollect
//   linkRel     7   ← <link rel="canonical"|"next"|"prev">
//   hreflang    5   ← locale alternates
//   feed        4   ← RSS / Atom / JSON feed entry URLs
//   sitemap     3   ← bucket-sampled across path prefixes when > budget
//   body        2   ← non-nav in-page links (blog thumbnails, card links)
//
// Sitemap URLs are bucket-sampled by first path segment so every section
// of the site gets representation rather than exhausting /news/ while
// /schemes/ and /contact/ never appear.
// ─────────────────────────────────────────────────────────────────────────
async function seedDiscovery({ tabId, startUrl, seedOrigin, queue, depth, discoveryStats }) {
  // Run all out-of-band discovery + nav-harvest in parallel. navSurfacedCollect
  // is the slow one (scroll + click-reveal, up to 45s) but it's on a
  // different resource (tab scripting) from the HTTP fetches, so it doesn't
  // contend. Failures are tolerated per source — a 404 sitemap shouldn't
  // kill feed discovery.
  const [sitemapUrls, homepageLinks, navLinks] = await Promise.all([
    seedOrigin ? discoverSeedsFromOrigin(seedOrigin).catch(() => []) : Promise.resolve([]),
    seedOrigin ? discoverHomepageLinks(startUrl).catch(() => ({ hreflang: [], canonical: null, nextPrev: [], feeds: [] })) : Promise.resolve({ hreflang: [], canonical: null, nextPrev: [], feeds: [] }),
    collectNavLinks(tabId).catch(() => [])
  ]);

  // Feed discovery depends on the homepage autodiscovery links, so it runs
  // after the first batch completes. Still cheap — only fires the HTTP
  // probes if we have an origin, and parseFeedEntries bails fast on HTML.
  const feedUrls = seedOrigin
    ? await discoverFeeds(seedOrigin, homepageLinks.feeds || []).catch(() => [])
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
}

async function scanInNewTab(url, collectNextLinks = false, { queue = null } = {}) {
  const tab = await chrome.tabs.create({ url, active: false });
  try {
    await waitForTabComplete(tab.id, TAB_TIMEOUT_MS);
    await sleep(SETTLE_MS);

    // Settled-URL dedup (post-SETTLE_MS so JS redirects have fired).
    if (queue) {
      const settledUrl = await waitForUrlSettle(tab.id);
      console.log(`[EU] worker settled: queued=${url}  → settled=${settledUrl}`);
      if (settledUrl && queue.hasSettled(settledUrl, url)) {
        console.log(`[EU] dedup skip: ${url} → ${settledUrl} (already scanned)`);
        return { __skipped: "redirect-to-duplicate", settledUrl, title: "" };
      }
      if (settledUrl) queue.markSettled(settledUrl, url);
    }

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
  // window.EU_IndiaChecks / window.EU_GIGWChecks / window.EU_MediaChecks so
  // the content-script can merge their output into the axe results + the
  // media inventory payload.
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
  const files = ["lib/axe.min.js", "lib/india-checks.js", "lib/gigw-checks.js", "lib/media-checks.js"];
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
  const mediaRows = [];   // one row per media / document item detected across the corpus
  const mediaSummary = {
    videos: 0, audios: 0, iframeVideos: 0, documents: 0,
    pdf: 0, spreadsheet: 0, document: 0, presentation: 0,
    videoIssues: 0, audioIssues: 0, iframeIssues: 0, documentIssues: 0
  };

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

    // Media & document inventory — one flat row per item. Keeps the per-item
    // issue list (as emitted by media-checks.js) so the renderer can group
    // findings under the item and the CSV can expose them as a pipe list.
    const mi = p.mediaInventory;
    if (mi && typeof mi === "object") {
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

  const mediaCols = [
    "url", "page_title", "kind", "subtype", "type_label", "family",
    "media_url", "accessible_name", "link_text", "context",
    "has_captions", "has_descriptions", "has_controls", "autoplay", "muted",
    "has_transcript", "has_type_hint", "has_size_hint",
    "opens_in_new_tab", "has_new_tab_notice",
    "title_attr", "aria_label", "duration_seconds", "vendor_label",
    "tracks", "issues", "issue_count", "selector", "html_snippet"
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
    `\r\n## WCAG 2.1 AA Summary\r\n` + summaryCsv +
    `\r\n\r\n## Conformance by Standard (WCAG / IS 17802 / GIGW / EN 301 549 / Section 508 / ADA)\r\n` + profilesCsv +
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
function safeOrigin(u) { try { return new URL(u).origin; } catch { return null; } }

// Poll chrome.tabs.get() until the tab's URL has been stable for two
// consecutive reads. Callers use this AFTER waitForTabComplete + SETTLE_MS,
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
