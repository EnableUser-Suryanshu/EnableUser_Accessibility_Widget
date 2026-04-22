const $ = (id) => document.getElementById(id);
const btnCurrent = $("btn-scan-current");
const btnMulti = $("btn-scan-multi");
const btnInventory = $("btn-scan-inventory");
const statusEl = $("status");
const maxUrlsInput = $("opt-max-urls");
const depthInput = $("opt-depth");
const profileSelect = $("opt-profile");

const DEFAULT_MAX_URLS = 50;
const DEFAULT_DEPTH = 0; // 0 = unbounded (inventory mode treats it as such)
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
  const profile = VALID_PROFILES.includes(profileSelect.value) ? profileSelect.value : "wcag21aa";
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
