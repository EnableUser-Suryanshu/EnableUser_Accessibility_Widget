const $ = (id) => document.getElementById(id);
const btnCurrent = $("btn-scan-current");
const btnMulti = $("btn-scan-multi");
const btnInventory = $("btn-scan-inventory");
const btnList = $("btn-scan-list");
const urlListInput = $("opt-url-list");
const statusEl = $("status");
const maxUrlsInput = $("opt-max-urls");
const depthInput = $("opt-depth");
const profileSelect = $("opt-profile");
const chkAxe = $("opt-check-axe");
const chkIndia = $("opt-check-india");
const chkIs17802 = $("opt-check-is17802");
const chkMedia = $("opt-check-media");
const chkPdfOffice = $("opt-check-pdfoffice");
const chkVisual = $("opt-check-visual");
const chkDismiss = $("opt-dismiss-overlays");
const chkAuditBoth = $("opt-audit-both");
const chkScreenshots = $("opt-screenshots");
const chkLinksOnly = $("opt-links-only");
const chkLinkCheck = $("opt-linkcheck");
const btnRecover = $("btn-recover");

// First-run defaults — what the operator sees the first time they open the
// popup with no stored preferences yet. WCAG 2.1 AA is the global baseline
// every supported standard maps to; 500 URLs keeps a first run fast on a
// large site (raise it once the site's size is known). Both are freely
// editable per-scan and overridden by whatever the operator last saved to
// chrome.storage.local.
const DEFAULT_MAX_URLS = 500;
const DEFAULT_DEPTH = 0; // 0 = unbounded (inventory mode treats it as such)
const DEFAULT_PROFILE = "wcag21aa";
// No HARD_MAX_URLS / HARD_MAX_DEPTH ceilings on this end either — the
// operator decides the size of the crawl. background.js enforces only a
// minimum floor (1) so no one accidentally launches a zero-URL scan.
const VALID_PROFILES = ["wcag21aa", "wcag22aa", "is17802", "combined_in", "en301549", "section508", "ada"];

chrome.storage?.local.get(["maxUrls", "crawlDepth", "profile", "checks", "dismissOverlays", "auditBoth", "screenshots", "linksOnly", "brokenLinks"]).then(s => {
  if (Number.isFinite(s?.maxUrls)) maxUrlsInput.value = s.maxUrls;
  if (Number.isFinite(s?.crawlDepth)) depthInput.value = s.crawlDepth;
  if (s?.profile && VALID_PROFILES.includes(s.profile)) profileSelect.value = s.profile;
  const c = s?.checks || {};
  if (chkAxe) chkAxe.checked = c.axe !== false;
  if (chkIndia) chkIndia.checked = c.india === true;
  if (chkIs17802) chkIs17802.checked = c.is17802 === true;
  if (chkMedia) chkMedia.checked = c.media !== false;
  if (chkPdfOffice) chkPdfOffice.checked = c.pdfOffice !== false;
  if (chkVisual) chkVisual.checked = c.visual !== false;
  if (chkDismiss && typeof s?.dismissOverlays === "boolean") chkDismiss.checked = s.dismissOverlays;
  if (chkAuditBoth && typeof s?.auditBoth === "boolean") chkAuditBoth.checked = s.auditBoth;
  // v0.4.5 — operator's default recipe: screenshots stay opt-in; real-pages
  // discovery is now the default (linked pages only, no sitemap/feed junk).
  if (chkScreenshots) chkScreenshots.checked = s?.screenshots === true;
  if (chkLinksOnly) chkLinksOnly.checked = s?.linksOnly !== false;
  // v0.4.4 — broken-link detection defaults ON.
  if (chkLinkCheck) chkLinkCheck.checked = s?.brokenLinks !== false;
}).catch(() => {});

// v0.4.4 — selecting an India compliance profile auto-enables the India /
// IS 17802 check suites (they're what those profiles are FOR — previously
// you could pick "IS 17802" and silently run without its own checks).
// Only ticks ON; never unticks a box the operator set themselves.
profileSelect?.addEventListener("change", () => {
  if (profileSelect.value === "is17802" || profileSelect.value === "combined_in") {
    if (chkIndia) chkIndia.checked = true;
    if (chkIs17802) chkIs17802.checked = true;
  }
});

function readScanOptions() {
  // Floor-only on maxUrls. No ceiling.
  const parsedMax = parseInt(maxUrlsInput.value, 10);
  const maxUrls = Number.isFinite(parsedMax) && parsedMax >= 1 ? parsedMax : DEFAULT_MAX_URLS;
  // Accept 0 as "unbounded" for inventory mode. background.js converts 0 to
  // Infinity. No upper clamp — the operator picks any depth they want.
  const rawDepth = parseInt(depthInput.value, 10);
  const crawlDepth = Number.isFinite(rawDepth) && rawDepth >= 0 ? rawDepth : DEFAULT_DEPTH;
  const profile = VALID_PROFILES.includes(profileSelect.value) ? profileSelect.value : DEFAULT_PROFILE;
  const checks = {
    axe: chkAxe ? chkAxe.checked : true,
    india: chkIndia ? chkIndia.checked : true,
    is17802: chkIs17802 ? chkIs17802.checked : true,
    media: chkMedia ? chkMedia.checked : true,
    pdfOffice: chkPdfOffice ? chkPdfOffice.checked : true,
    visual: chkVisual ? chkVisual.checked : true
  };
  const dismissOverlays = chkDismiss ? chkDismiss.checked : false;
  const auditBoth = chkAuditBoth ? chkAuditBoth.checked : false;
  const screenshots = chkScreenshots ? chkScreenshots.checked : false;
  const linksOnly = chkLinksOnly ? chkLinksOnly.checked : false;
  const brokenLinks = chkLinkCheck ? chkLinkCheck.checked : true;
  maxUrlsInput.value = maxUrls;
  depthInput.value = crawlDepth;
  chrome.storage?.local.set({ maxUrls, crawlDepth, profile, checks, dismissOverlays, auditBoth, screenshots, linksOnly, brokenLinks }).catch(() => {});
  return { maxUrls, crawlDepth, profile, checks, dismissOverlays, auditBoth, screenshots, linksOnly, brokenLinks };
}

function setStatus(msg, isError = false) {
  if (!msg) { statusEl.hidden = true; statusEl.textContent = ""; return; }
  statusEl.hidden = false;
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

// ── Live progress wiring ────────────────────────────────────────────────
// background.js writes { "scan-progress": { active, done, total, currentUrl }}
// into chrome.storage.local after every URL finishes. The popup reflects
// this back to the user so they can see the crawl is making progress
// (instead of staring at a blank "this may take a while" message for ten
// minutes wondering if it's hung). Works even when the popup was closed
// during the crawl — re-opening the extension picks up the live state.
function shortenUrl(u, max = 60) {
  if (!u) return "";
  try {
    const url = new URL(u);
    const s = url.pathname + (url.search || "");
    return (s.length <= max ? s : s.slice(0, max - 1) + "…") || url.hostname;
  } catch { return u.length <= max ? u : u.slice(0, max - 1) + "…"; }
}
function renderProgress(p) {
  if (!p || !p.active) {
    // Only clear the status line if it was showing progress — don't wipe
    // out the "Opening report…" final message that the button handlers set.
    if (statusEl.dataset.mode === "progress") setStatus(null);
    return;
  }
  const { done = 0, total = 0, currentUrl = "" } = p;
  const totalLabel = total > 0 ? total : "?";
  const line = `Scanning ${done}/${totalLabel}${currentUrl ? ` — ${shortenUrl(currentUrl)}` : ""}`;
  statusEl.hidden = false;
  statusEl.textContent = line;
  statusEl.classList.remove("error");
  statusEl.dataset.mode = "progress";
}
// Initial paint from whatever's in storage (popup was just opened).
chrome.storage?.local.get("scan-progress").then(got => renderProgress(got?.["scan-progress"])).catch(() => {});
// Live updates while the popup is open.
chrome.storage?.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes["scan-progress"]) return;
  renderProgress(changes["scan-progress"].newValue);
});

function setBusy(busy) {
  btnCurrent.disabled = busy;
  btnMulti.disabled = busy;
  if (btnInventory) btnInventory.disabled = busy;
  if (btnList) btnList.disabled = busy;
  if (btnRecover) btnRecover.disabled = busy;
}

// ── v0.4.3 — crash recovery ──────────────────────────────────────────────
// background.js checkpoints the in-progress crawl to chrome.storage.local
// every 20 pages. If a checkpoint exists while no scan is running, the
// browser (or the service worker) died mid-crawl — offer to rebuild a
// report from the partial results.
chrome.storage?.local.get(["eu-crawl-checkpoint", "scan-progress"]).then(s => {
  const cp = s?.["eu-crawl-checkpoint"];
  const running = s?.["scan-progress"]?.active === true;
  if (btnRecover && cp && Array.isArray(cp.pages) && cp.pages.length > 0 && !running) {
    btnRecover.hidden = false;
    btnRecover.textContent = `Recover interrupted crawl (${cp.pages.length} pages scanned)`;
  }
}).catch(() => {});

btnRecover?.addEventListener("click", async () => {
  setBusy(true);
  setStatus("Rebuilding report from the interrupted crawl…");
  const res = await send({ type: "RECOVER_CHECKPOINT" });
  setBusy(false);
  if (!res?.ok) { setStatus(res?.error || "Recovery failed.", true); return; }
  setStatus("Recovered report opening…");
  window.close();
});

function send(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

async function getActiveTab() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  return tab;
}

async function ensureHostPermission(urlString) {
  const origin = new URL(urlString).origin;
  const has = await chrome.permissions.contains({ origins: [`${origin}/*`] });
  if (has) return true;
  return chrome.permissions.request({ origins: [`${origin}/*`] });
}

btnCurrent.addEventListener("click", async () => {
  setStatus(null);
  const tab = await getActiveTab();
  if (!tab || !/^https?:/.test(tab.url || "")) {
    setStatus("Open an http(s) page first.", true);
    return;
  }
  const granted = await ensureHostPermission(tab.url);
  if (!granted) { setStatus("Permission denied.", true); return; }

  const opts = readScanOptions();
  setBusy(true);
  setStatus(`Scanning current page (${opts.profile})…`);
  const res = await send({ type: "SCAN_CURRENT", tabId: tab.id, options: opts });
  setBusy(false);
  if (!res?.ok) { setStatus(res?.error || "Scan failed.", true); return; }
  setStatus("Opening report…");
  window.close();
});

btnMulti.addEventListener("click", async () => {
  setStatus(null);
  const tab = await getActiveTab();
  if (!tab || !/^https?:/.test(tab.url || "")) {
    setStatus("Open an http(s) page first.", true);
    return;
  }
  const granted = await ensureHostPermission(tab.url);
  if (!granted) { setStatus("Permission denied.", true); return; }

  const opts = readScanOptions();
  setBusy(true);
  setStatus(`Starting multi-page scan (up to ${opts.maxUrls} URLs, depth ${opts.crawlDepth})… this may take a minute.`);
  const res = await send({ type: "SCAN_MULTI", tabId: tab.id, options: opts });
  setBusy(false);
  if (!res?.ok) { setStatus(res?.error || "Scan failed.", true); return; }
  setStatus("Report opening in new tab…");
  window.close();
});

btnInventory?.addEventListener("click", async () => {
  setStatus(null);
  const tab = await getActiveTab();
  if (!tab || !/^https?:/.test(tab.url || "")) {
    setStatus("Open an http(s) page first.", true);
    return;
  }
  const granted = await ensureHostPermission(tab.url);
  if (!granted) { setStatus("Permission denied.", true); return; }

  const opts = readScanOptions();
  const depthLabel = opts.crawlDepth === 0 ? "unbounded" : String(opts.crawlDepth);
  setBusy(true);
  setStatus(`Full-audit crawl (up to ${opts.maxUrls} URLs, depth ${depthLabel}) — axe + India + IS 17802 + component inventory per page${opts.screenshots ? " + screenshots" : ""}. This will take a while…`);
  const res = await send({ type: "SCAN_INVENTORY", tabId: tab.id, options: opts });
  setBusy(false);
  if (!res?.ok) { setStatus(res?.error || "Scope failed.", true); return; }
  setStatus("Scope document opening…");
  window.close();
});

// ── Template Check (paste URL list) ──────────────────────────────────────
// No discovery, no link following, no filter. The operator pastes URLs;
// we visit each, compute the template fingerprint, and render every URL
// as its own row in the inventory (with template clustering shown
// separately). Host permission is requested per-origin across the entire
// pasted list so a single prompt covers every domain in one go.
btnList?.addEventListener("click", async () => {
  setStatus(null);
  const raw = (urlListInput?.value || "").trim();
  if (!raw) {
    setStatus("Paste at least one URL into the list box.", true);
    return;
  }
  // Parse locally so we can (a) build the permission origin set and
  // (b) surface parse errors before spinning up a scan.
  const lines = raw.split(/\r?\n/);
  const urls = [];
  const origins = new Set();
  for (const line of lines) {
    const s = String(line || "").trim();
    if (!s || s.startsWith("#")) continue;
    let parsed = null;
    try { parsed = new URL(s); } catch {}
    if (!parsed && !/^[a-z][a-z0-9+.-]*:/i.test(s)) {
      try { parsed = new URL(`https://${s}`); } catch {}
    }
    if (!parsed) continue; // background will emit it as an error row
    if (!/^https?:$/.test(parsed.protocol)) continue;
    urls.push(parsed.href);
    origins.add(parsed.origin);
  }
  if (urls.length === 0) {
    setStatus("No valid http(s) URLs found in the list.", true);
    return;
  }

  // Batch all origins into one permission request to minimize prompts.
  const wantOrigins = [...origins].map(o => `${o}/*`);
  const hasAll = await chrome.permissions.contains({ origins: wantOrigins }).catch(() => false);
  if (!hasAll) {
    const granted = await chrome.permissions.request({ origins: wantOrigins }).catch(() => false);
    if (!granted) { setStatus("Permission denied for one or more origins in the list.", true); return; }
  }

  const opts = readScanOptions();
  setBusy(true);
  setStatus(`Template check — scanning ${urls.length} URL${urls.length === 1 ? "" : "s"} (${opts.profile}). Axe + fingerprint${opts.screenshots ? " + screenshot" : ""} per URL.`);
  const res = await send({
    type: "SCAN_LIST",
    options: { urls, profile: opts.profile, checks: opts.checks, dismissOverlays: opts.dismissOverlays, auditBoth: opts.auditBoth, screenshots: opts.screenshots }
  });
  setBusy(false);
  if (!res?.ok) { setStatus(res?.error || "Template check failed.", true); return; }
  setStatus("Template report opening…");
  window.close();
});
