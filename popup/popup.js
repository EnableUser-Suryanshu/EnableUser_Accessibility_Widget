const $ = (id) => document.getElementById(id);
const btnCurrent = $("btn-scan-current");
const btnMulti = $("btn-scan-multi");
const statusEl = $("status");
const maxUrlsInput = $("opt-max-urls");
const depthInput = $("opt-depth");
const profileSelect = $("opt-profile");

const DEFAULT_MAX_URLS = 50;
const DEFAULT_DEPTH = 1;
const HARD_MAX_URLS = 500;
const HARD_MAX_DEPTH = 5;
const VALID_PROFILES = ["wcag21aa", "is17802", "gigw3", "en301549", "section508", "ada"];

chrome.storage?.local.get(["maxUrls", "crawlDepth", "profile"]).then(s => {
  if (Number.isFinite(s?.maxUrls)) maxUrlsInput.value = s.maxUrls;
  if (Number.isFinite(s?.crawlDepth)) depthInput.value = s.crawlDepth;
  if (s?.profile && VALID_PROFILES.includes(s.profile)) profileSelect.value = s.profile;
}).catch(() => {});

function readScanOptions() {
  const maxUrls = clamp(parseInt(maxUrlsInput.value, 10) || DEFAULT_MAX_URLS, 1, HARD_MAX_URLS);
  const crawlDepth = clamp(parseInt(depthInput.value, 10) || DEFAULT_DEPTH, 1, HARD_MAX_DEPTH);
  const profile = VALID_PROFILES.includes(profileSelect.value) ? profileSelect.value : "wcag21aa";
  maxUrlsInput.value = maxUrls;
  depthInput.value = crawlDepth;
  chrome.storage?.local.set({ maxUrls, crawlDepth, profile }).catch(() => {});
  return { maxUrls, crawlDepth, profile };
}

function clamp(n, lo, hi) { return Math.max(lo, Math.min(hi, n)); }

function setStatus(msg, isError = false) {
  if (!msg) { statusEl.hidden = true; statusEl.textContent = ""; return; }
  statusEl.hidden = false;
  statusEl.textContent = msg;
  statusEl.classList.toggle("error", isError);
}

function setBusy(busy) {
  btnCurrent.disabled = busy;
  btnMulti.disabled = busy;
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
