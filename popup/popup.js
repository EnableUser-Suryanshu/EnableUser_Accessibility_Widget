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

// First-run defaults — what the operator sees the first time they open the
// popup with no stored preferences yet. Combined (WCAG + IS 17802 + GIGW)
// covers the India-compliance use case most users of this build are here
// for, and 5000 URLs is a sensible ceiling for mid-size marketing/content
// sites without being so large it invites runaway crawls. Both are freely
// editable per-scan and overridden by whatever the operator last saved to
// chrome.storage.local.
const DEFAULT_MAX_URLS = 5000;
const DEFAULT_DEPTH = 0; // 0 = unbounded (inventory mode treats it as such)
const DEFAULT_PROFILE = "combined_in";
// No HARD_MAX_URLS / HARD_MAX_DEPTH ceilings on this end either — the
// operator decides the size of the crawl. background.js enforces only a
// minimum floor (1) so no one accidentally launches a zero-URL scan.
const VALID_PROFILES = ["wcag21aa", "is17802", "gigw3", "combined_in", "en301549", "section508", "ada"];

chrome.storage?.local.get(["maxUrls", "crawlDepth", "profile"]).then(s => {
  if (Number.isFinite(s?.maxUrls)) maxUrlsInput.value = s.maxUrls;
  if (Number.isFinite(s?.crawlDepth)) depthInput.value = s.crawlDepth;
  if (s?.profile && VALID_PROFILES.includes(s.profile)) profileSelect.value = s.profile;
}).catch(() => {});

function readScanOptions() {
  // Floor-only on maxUrls. No ceiling.
  const parsedMax = parseInt(maxUrlsInput.value, 10);
  const maxUrls = Number.isFinite(parsedMax) && parsedMax >= 1 ? parsedMax : DEFAULT_MAX_URLS;
  // Accept 0 as "unbounded" for inventory mode. background.js converts 0 to
  // Infinity. No upper clamp — the operator picks any depth they want.
  const rawDepth = parseInt(depthInput.value, 10);
  const crawlDepth = Number.isFinite(rawDepth) && rawDepth >= 0 ? rawDepth : DEFAULT_DEPTH;
  const profile = VALID_PROFILES.includes(profileSelect.value) ? profileSelect.value : DEFAULT_PROFILE;
  maxUrlsInput.value = maxUrls;
  depthInput.value = crawlDepth;
  chrome.storage?.local.set({ maxUrls, crawlDepth, profile }).catch(() => {});
  return { maxUrls, crawlDepth, profile };
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
}

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
  setStatus(`Full-audit crawl (up to ${opts.maxUrls} URLs, depth ${depthLabel}) — axe + India + GIGW + screenshots + component inventory per page. This will take a while…`);
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
  setStatus(`Template check — scanning ${urls.length} URL${urls.length === 1 ? "" : "s"} (${opts.profile}). Axe + screenshot + fingerprint per URL.`);
  const res = await send({
    type: "SCAN_LIST",
    options: { urls, profile: opts.profile }
  });
  setBusy(false);
  if (!res?.ok) { setStatus(res?.error || "Template check failed.", true); return; }
  setStatus("Template report opening…");
  window.close();
});
