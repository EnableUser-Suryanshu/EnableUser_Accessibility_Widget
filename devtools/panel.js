// Panel logic — a live view over the background's workflow session for the
// inspected tab. Deliberately dumb: it owns no session state, it just renders
// WORKFLOW_STATUS / WORKFLOW_DETAIL and forwards Start/Stop. tabId comes from
// the query string (set by devtools.js), so this file never touches
// chrome.devtools APIs and stays testable in isolation.
const tabId = Number(new URLSearchParams(location.search).get("tabId"));
const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));

const btnRecord = $("btn-record");
const btnReport = $("btn-report");
let lastReportId = null;
let polling = null;

function setStatus(t) { $("status").textContent = t || ""; }

function render(detail) {
  const active = !!detail?.active;
  $("rec-dot").hidden = !active;
  btnRecord.textContent = active ? "Stop & build report" : "Start recording";
  btnRecord.classList.toggle("recording", active);
  $("stats").hidden = !active && !(detail?.steps?.length);
  const s = detail || {};
  $("st-pages").textContent = s.pages?.length ?? s.pages ?? 0;
  $("st-steps").textContent = s.steps?.length ?? s.steps ?? 0;
  $("st-scans").textContent = s.counts?.scans ?? s.scans ?? 0;
  $("st-issues").textContent = s.counts?.newIssues ?? s.newIssues ?? 0;
  $("st-dupes").textContent = s.counts?.suppressedDuplicates ?? s.suppressedDuplicates ?? 0;

  const steps = Array.isArray(s.steps) ? s.steps : [];
  $("empty").hidden = active || steps.length > 0;
  const ol = $("timeline");
  ol.replaceChildren(...steps.slice().reverse().map((st) => {
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
  }));
  if (s.limitReached) setStatus("Step limit reached — stop to build the report.");
}

async function refresh() {
  const detail = await send({ type: "WORKFLOW_DETAIL", tabId });
  if (detail?.ok) render(detail);
}

btnRecord.addEventListener("click", async () => {
  btnRecord.disabled = true;
  try {
    if (btnRecord.classList.contains("recording")) {
      setStatus("Building report + AI evidence bundle…");
      const res = await send({ type: "WORKFLOW_STOP", tabId });
      if (!res?.ok) { setStatus(res?.error || "Stop failed."); return; }
      lastReportId = res.reportId;
      btnReport.hidden = false;
      setStatus(`Done — ${res.pages} page(s), ${res.steps} step(s), ${res.newIssues} unique issue(s). Report opened; evidence bundle downloaded.`);
      await refresh();
    } else {
      setStatus("Starting — first scan running…");
      const res = await send({ type: "WORKFLOW_START", tabId });
      if (!res?.ok) { setStatus(res?.error || "Start failed."); return; }
      setStatus("Recording. Browse the journey in the inspected tab.");
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
polling = setInterval(refresh, 1500);
window.addEventListener("unload", () => clearInterval(polling));
