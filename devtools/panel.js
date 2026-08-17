// Panel logic — the primary testing surface inside the inspector. Owns no
// session state: renders WORKFLOW_DETAIL (steps + live activity) and forwards
// actions. tabId arrives via query string from devtools.js, so this file
// never touches chrome.devtools APIs and stays testable in isolation.
//
// The activity strip is the point (both vendors live or die by their
// "Analyzing, please wait…" states): settling = a change was detected and
// the debounce is running; scanning = axe is in flight. A local flag covers
// panel-initiated single scans the same way.
const tabId = Number(new URLSearchParams(location.search).get("tabId"));
const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));

const btnScan = $("btn-scan");
const btnRecord = $("btn-record");
const btnReport = $("btn-report");
let lastReportId = null;
let localScanning = false;   // panel-initiated single scan in flight

function setStatus(t) { $("status").textContent = t || ""; }

function setActivity(text) {
  $("activity").hidden = !text;
  $("activity-text").textContent = text || "";
}

function activityText(detail) {
  if (localScanning) return "Scanning this page — axe + custom checks running. This can take up to a minute on heavy pages…";
  const a = detail?.activity || {};
  if (a.scanning) return "Analyzing, please wait — scanning the current page state…";
  if (a.settling) return a.pendingAction === "Full page scan"
    ? "Page loaded — waiting for it to settle before scanning…"
    : "Change detected — waiting for the page to settle before scanning…";
  if (detail?.active) return "Recording — watching this tab for page loads and changes. Browse the journey.";
  return null;
}

function render(detail) {
  const active = !!detail?.active;
  $("rec-dot").hidden = !active;
  btnRecord.textContent = active ? "Stop & build report" : "Record workflow";
  btnRecord.classList.toggle("recording", active);
  btnRecord.classList.toggle("primary", active);
  btnScan.disabled = active || localScanning;
  setActivity(activityText(detail));

  const s = detail || {};
  const steps = Array.isArray(s.steps) ? s.steps : [];
  $("stats").hidden = !active && steps.length === 0;
  $("st-pages").textContent = s.pages?.length ?? 0;
  $("st-steps").textContent = steps.length;
  $("st-scans").textContent = s.counts?.scans ?? 0;
  $("st-issues").textContent = s.counts?.newIssues ?? 0;
  $("st-dupes").textContent = s.counts?.suppressedDuplicates ?? 0;

  $("empty").hidden = active || steps.length > 0 || localScanning;
  const ol = $("timeline");
  const items = steps.slice().reverse().map((st) => {
    const li = document.createElement("li");
    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.textContent = st.action === "Clicked" ? "☞" : st.action === "Full page scan" ? "▣" : "≈";
    const mid = document.createElement("div");
    const a = document.createElement("div");
    a.className = "action " + (st.action === "Full page scan" ? "scan" : st.action === "Clicked" ? "" : "change");
    a.textContent = st.action + (st.detail ? " — " : "");
    if (st.detail) {
      const d = document.createElement("span");
      d.className = "detail";
      d.textContent = st.detail;
      a.appendChild(d);
    }
    const u = document.createElement("div");
    u.className = "url";
    u.textContent = st.url || "";
    mid.append(a, u);
    const c = document.createElement("span");
    const n = st.newIssues || 0;
    c.className = "count " + (n ? "new" : "zero");
    c.textContent = st.scans ? `${n} new` : "";
    li.append(glyph, mid, c);
    return li;
  });
  // Live pseudo-row on top while a workflow scan runs, axe-style.
  if (active && (detail?.activity?.scanning || detail?.activity?.settling)) {
    const li = document.createElement("li");
    li.className = "live";
    const glyph = document.createElement("span");
    glyph.className = "glyph";
    glyph.textContent = "◌";
    const mid = document.createElement("div");
    const a = document.createElement("div");
    a.className = "action";
    a.textContent = detail.activity.scanning ? "Analyzing…" : "Waiting for the page to settle…";
    mid.append(a);
    li.append(glyph, mid, document.createElement("span"));
    items.unshift(li);
  }
  ol.replaceChildren(...items);
  if (s.limitReached) setStatus("Step limit reached — stop to build the report.");
}

async function refresh() {
  const detail = await send({ type: "WORKFLOW_DETAIL", tabId });
  if (detail?.ok) render(detail);
}

btnScan.addEventListener("click", async () => {
  localScanning = true;
  btnScan.disabled = true;
  btnRecord.disabled = true;
  setActivity(activityText(null));
  setStatus("");
  try {
    const res = await send({ type: "PANEL_SCAN_PAGE", tabId });
    if (!res?.ok) { setStatus(res?.error || "Scan failed."); return; }
    lastReportId = res.reportId;
    btnReport.hidden = false;
    setStatus("Scan complete — report opened in a new tab.");
  } finally {
    localScanning = false;
    btnScan.disabled = false;
    btnRecord.disabled = false;
    setActivity(null);
    refresh();
  }
});

btnRecord.addEventListener("click", async () => {
  btnRecord.disabled = true;
  try {
    if (btnRecord.classList.contains("recording")) {
      setActivity("Building the report and the AI evidence bundle…");
      const res = await send({ type: "WORKFLOW_STOP", tabId });
      setActivity(null);
      if (!res?.ok) { setStatus(res?.error || "Stop failed."); await refresh(); return; }
      lastReportId = res.reportId;
      btnReport.hidden = false;
      setStatus(`Done — ${res.pages} page(s), ${res.steps} step(s), ${res.newIssues} unique issue(s). Report opened; evidence bundle downloaded.`);
      await refresh();
    } else {
      setActivity("Starting — running the first full page scan…");
      const res = await send({ type: "WORKFLOW_START", tabId });
      if (!res?.ok) { setActivity(null); setStatus(res?.error || "Start failed."); return; }
      setStatus("");
      await refresh();
    }
  } finally {
    btnRecord.disabled = false;
  }
});

btnReport.addEventListener("click", () => {
  if (lastReportId) chrome.tabs.create({ url: chrome.runtime.getURL(`report/report.html?id=${lastReportId}`) });
});

refresh();
const polling = setInterval(refresh, 1000);
window.addEventListener("unload", () => clearInterval(polling));
