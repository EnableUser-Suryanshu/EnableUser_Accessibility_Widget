// DevTools panel — the full extension surface inside the inspector: page
// scan, highlight, site crawl, template check, workflow recorder, recovery,
// and settings (persisted to the SAME storage keys the popup uses, so the
// two surfaces always agree). tabId arrives via query string from
// devtools.js; no chrome.devtools APIs are used here.
const tabId = Number(new URLSearchParams(location.search).get("tabId"));
const $ = (id) => document.getElementById(id);
const send = (msg) => new Promise((r) => chrome.runtime.sendMessage(msg, r));

const btnScan = $("btn-scan");
const btnRecord = $("btn-record");
const btnReport = $("btn-report");
const btnCrawl = $("btn-crawl");
const btnList = $("btn-list");
const btnRecover = $("btn-recover");
let lastReportId = null;
let localBusy = null; // "scan" | "crawl" | "list" | null — panel-initiated op in flight

function setStatus(t) { $("status").textContent = t || ""; }
function setActivity(text) { $("activity").hidden = !text; $("activity-text").textContent = text || ""; }

// ── Settings: same keys as popup/popup.js ────────────────────────────────
const CHECK_IDS = {
  axe: "opt-check-axe", india: "opt-check-india", is17802: "opt-check-is17802",
  media: "opt-check-media", pdfOffice: "opt-check-pdfoffice", visual: "opt-check-visual"
};
async function loadSettings() {
  try {
    const s = await chrome.storage.local.get(["maxUrls", "crawlDepth", "profile", "checks", "dismissOverlays", "auditBoth", "screenshots", "linksOnly", "brokenLinks", "wfScanOnActivity", "wfElementShots", "engineVersion"]);
    if (s.engineVersion) $("opt-engine").value = s.engineVersion;
    if (Number.isFinite(s.maxUrls)) $("opt-max-urls").value = s.maxUrls;
    if (Number.isFinite(s.crawlDepth)) $("opt-depth").value = s.crawlDepth;
    if (s.profile) $("opt-profile").value = s.profile;
    const c = s.checks || {};
    $("opt-check-axe").checked = c.axe !== false;
    $("opt-check-india").checked = c.india !== false;      // default recipe: on
    $("opt-check-is17802").checked = c.is17802 !== false;  // default recipe: on
    $("opt-check-media").checked = c.media === true;
    $("opt-check-pdfoffice").checked = c.pdfOffice === true;
    $("opt-check-visual").checked = c.visual === true;
    if (typeof s.dismissOverlays === "boolean") $("opt-dismiss-overlays").checked = s.dismissOverlays;
    if (typeof s.auditBoth === "boolean") $("opt-audit-both").checked = s.auditBoth;
    $("opt-screenshots").checked = s.screenshots === true;
    $("opt-links-only").checked = s.linksOnly !== false;
    $("opt-linkcheck").checked = s.brokenLinks !== false;
    $("opt-wf-activity").checked = s.wfScanOnActivity === true;  // default: DOM observer
    $("opt-wf-elementshots").checked = s.wfElementShots === true; // default: OFF (debugger infobar mid-browse)
  } catch {}
}
function readSettings() {
  const maxUrls = Math.max(1, parseInt($("opt-max-urls").value, 10) || 500);
  const crawlDepth = Math.max(0, parseInt($("opt-depth").value, 10) || 0);
  const profile = $("opt-profile").value;
  const checks = {};
  for (const [k, id] of Object.entries(CHECK_IDS)) checks[k] = $(id).checked;
  const opts = {
    maxUrls, crawlDepth, profile, checks,
    dismissOverlays: $("opt-dismiss-overlays").checked,
    auditBoth: $("opt-audit-both").checked,
    screenshots: $("opt-screenshots").checked,
    linksOnly: $("opt-links-only").checked,
    brokenLinks: $("opt-linkcheck").checked,
    wfScanOnActivity: $("opt-wf-activity").checked,
    wfElementShots: $("opt-wf-elementshots").checked,
    engineVersion: $("opt-engine").value
  };
  chrome.storage.local.set(opts).catch(() => {});
  return opts;
}
document.querySelector("main").addEventListener("change", () => readSettings());

async function inspectedTab() {
  try { return await chrome.tabs.get(tabId); } catch { return null; }
}
async function ensureHostPermission(url) {
  try {
    const origin = new URL(url).origin + "/*";
    if (await chrome.permissions.contains({ origins: [origin] })) return true;
    return await chrome.permissions.request({ origins: [origin] });
  } catch { return true; } // host_permissions in manifest usually cover it
}

// ── Activity: workflow runtime + crawl progress + local ops ──────────────
function activityText(detail, progress) {
  if (localBusy === "scan") return "Scanning this page — axe + custom checks running…";
  if (localBusy === "guided") return "Guided test running — Chrome's debugging banner is expected while it works…";
  if (localBusy === "list") return "Template check running — auditing each pasted URL…";
  if (localBusy === "crawl" || progress?.active) {
    const p = progress || {};
    return `Crawling — ${p.done ?? 0}/${p.total || "?"}${p.currentUrl ? " — " + String(p.currentUrl).slice(0, 70) : ""}`;
  }
  const a = detail?.activity || {};
  if (a.scanning) return "Analyzing, please wait — scanning the current page state…";
  if (a.settling) return a.pendingAction === "Full page scan"
    ? "Page loaded — waiting for it to settle before scanning…"
    : "Change detected — waiting for the page to settle before scanning…";
  if (detail?.active) return "Recording — watching this tab for page loads and changes. Browse the journey.";
  return null;
}

function render(detail, progress) {
  const active = !!detail?.active;
  $("rec-dot").hidden = !active;
  btnRecord.textContent = active ? "Stop & build report" : "Scan user flow";
  btnRecord.classList.toggle("recording", active);
  btnScan.disabled = active || !!localBusy;
  btnCrawl.disabled = active || !!localBusy;
  btnList.disabled = active || !!localBusy;
  // Guided tests drive the page (trusted keys, viewport override) — they
  // must not run while a recording would treat their churn as user activity.
  $("btn-gt-keyboard").disabled = active || !!localBusy;
  $("btn-gt-reflow").disabled = active || !!localBusy;
  setActivity(activityText(detail, progress));

  // A workflow scan continuously in flight for > 8 s (BrowserStack's
  // force-stop threshold) gets an escape hatch: discard the stuck scan's
  // result and release the lock, without ending the session.
  const act = detail?.activity || {};
  $("btn-force-stop").hidden =
    !(active && act.scanning && act.scanStartedAt && Date.now() - act.scanStartedAt > 8000);

  const steps = Array.isArray(detail?.steps) ? detail.steps : [];
  $("stats").hidden = !active && steps.length === 0;
  $("st-pages").textContent = detail?.pages?.length ?? 0;
  $("st-steps").textContent = steps.length;
  $("st-scans").textContent = detail?.counts?.scans ?? 0;
  $("st-issues").textContent = detail?.counts?.newIssues ?? 0;
  $("st-dupes").textContent = detail?.counts?.suppressedDuplicates ?? 0;

  const items = steps.slice().reverse().map((st) => {
    const li = document.createElement("li");
    li.dataset.stepId = st.stepId;
    li.dataset.detail = st.detail || "";
    li.title = "Double-click to rename this step";
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
  $("timeline").replaceChildren(...items);
}

async function refresh() {
  const [detail, stored] = await Promise.all([
    send({ type: "WORKFLOW_DETAIL", tabId }),
    chrome.storage.local.get(["scan-progress", "eu-crawl-checkpoint"]).catch(() => ({}))
  ]);
  if (detail?.ok) render(detail, stored?.["scan-progress"]);
  const cp = stored?.["eu-crawl-checkpoint"];
  btnRecover.hidden = !(cp && Array.isArray(cp.pages) && cp.pages.length && !stored?.["scan-progress"]?.active);
  if (!btnRecover.hidden) btnRecover.textContent = `Recover interrupted crawl (${cp.pages.length} pages)`;
}

// ── Actions ──────────────────────────────────────────────────────────────
async function runOp(kind, fn) {
  localBusy = kind;
  setStatus("");
  setActivity(activityText(null));
  try { await fn(); }
  finally { localBusy = null; setActivity(null); refresh(); }
}

btnScan.addEventListener("click", () => runOp("scan", async () => {
  const res = await send({ type: "PANEL_SCAN_PAGE", tabId });
  if (!res?.ok) { setStatus(res?.error || "Scan failed."); return; }
  lastReportId = res.reportId;
  btnReport.hidden = false;
  setStatus("Scan complete — report opened in a new tab.");
  renderIssueList(res.reportId);
}));

btnCrawl.addEventListener("click", () => runOp("crawl", async () => {
  const tab = await inspectedTab();
  if (!tab || !/^https?:/.test(tab.url || "")) { setStatus("Open an http(s) page first."); return; }
  if (!(await ensureHostPermission(tab.url))) { setStatus("Permission denied."); return; }
  const res = await send({ type: "SCAN_INVENTORY", tabId, options: readSettings() });
  setStatus(res?.ok ? "Crawl complete — inventory opened in a new tab." : (res?.error || "Crawl failed."));
}));

btnList.addEventListener("click", () => runOp("list", async () => {
  const urls = $("opt-url-list").value.split(/\r?\n/).map(s => s.trim()).filter(s => s && !s.startsWith("#"));
  if (!urls.length) { setStatus("Paste at least one URL."); return; }
  const o = readSettings();
  const res = await send({ type: "SCAN_LIST", options: { urls, profile: o.profile, checks: o.checks, dismissOverlays: o.dismissOverlays, auditBoth: o.auditBoth, screenshots: o.screenshots } });
  setStatus(res?.ok ? "Template check complete — report opened." : (res?.error || "Template check failed."));
}));

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
      setStatus(`Done — ${res.pages} page(s), ${res.steps} step(s), ${res.newIssues} unique issue(s).`);
      renderIssueList(res.reportId);
    } else {
      setActivity("Starting — running the first full page scan…");
      const res = await send({ type: "WORKFLOW_START", tabId, options: readSettings() });
      if (!res?.ok) { setActivity(null); setStatus(res?.error || "Start failed."); return; }
      setStatus("");
    }
    await refresh();
  } finally {
    btnRecord.disabled = false;
  }
});

// ── In-panel issue list (Phase D) — fetch the freshly built report and
// render a collapsible by-rule digest so the operator triages without
// leaving the inspector. No caps: every rule, every node. ────────────────
async function renderIssueList(reportId) {
  try {
    const res = await send({ type: "GET_REPORT", reportId });
    const report = res?.report;
    if (!report) return;
    // Group violation rows by rule; issueRows carry one row per node×criterion,
    // so dedupe nodes within a rule by selector for the count.
    const byRule = new Map();
    for (const r of report.issueRows || []) {
      let g = byRule.get(r.rule_id);
      if (!g) { g = { impact: r.impact || r.rule_impact || "", description: r.rule_description || "", selectors: new Set() }; byRule.set(r.rule_id, g); }
      g.selectors.add(r.selector || "(no selector)");
    }
    const list = $("issue-list");
    list.replaceChildren();
    const impactRank = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    const rules = [...byRule.entries()].sort((a, b) =>
      (impactRank[a[1].impact] ?? 9) - (impactRank[b[1].impact] ?? 9) || b[1].selectors.size - a[1].selectors.size);
    for (const [ruleId, g] of rules) {
      const details = document.createElement("details");
      const summary = document.createElement("summary");
      const rule = document.createElement("span"); rule.className = "rule"; rule.textContent = ruleId;
      const impact = document.createElement("span"); impact.className = `impact ${g.impact}`; impact.textContent = g.impact;
      const count = document.createElement("span"); count.className = "count"; count.textContent = `${g.selectors.size} element(s)`;
      summary.append(rule, impact, count);
      const desc = document.createElement("div"); desc.className = "desc"; desc.textContent = g.description;
      const ul = document.createElement("ul"); ul.className = "nodes";
      for (const sel of g.selectors) { const li = document.createElement("li"); li.textContent = sel; ul.appendChild(li); }
      details.append(summary, desc, ul);
      list.appendChild(details);
    }
    $("issues-meta").textContent = rules.length
      ? `— ${rules.length} rule(s), ${(report.issueRows || []).length} finding row(s)`
      : "— no violations in the last run";
    $("issues-card").hidden = false;
  } catch { /* the full report tab still has everything */ }
}
$("btn-issues-highlight").addEventListener("click", async () => {
  // HIGHLIGHT_ISSUES re-runs the scan and marks every confirmed violation —
  // the existing handler has no per-selector scoping, so this is all-issues
  // by design (a re-run also guarantees markers match the page as it is NOW).
  const res = await send({ type: "HIGHLIGHT_ISSUES", tabId, options: readSettings() });
  setStatus(res?.ok ? `Highlighted ${res.issues} issue(s) on the page.` : (res?.error || "Highlight failed."));
});
$("btn-issues-open").addEventListener("click", () => {
  if (lastReportId) chrome.tabs.create({ url: chrome.runtime.getURL(`report/report.html?id=${lastReportId}`) });
});

// ── Guided tests (Phase C — CDP layer) ───────────────────────────────────
function gtRow(label, detail, isFinding) {
  const li = document.createElement("li");
  const glyph = document.createElement("span");
  glyph.className = "glyph";
  glyph.textContent = isFinding ? "⚑" : "✓";
  const mid = document.createElement("div");
  const a = document.createElement("div");
  a.className = "action" + (isFinding ? "" : " scan");
  a.textContent = label;
  const u = document.createElement("div");
  u.className = "url";
  u.textContent = detail || "";
  mid.append(a, u);
  li.append(glyph, mid, document.createElement("span"));
  $("gt-results").prepend(li);
  $("btn-gt-report").hidden = false;
}

$("btn-gt-keyboard").addEventListener("click", () => runOp("guided", async () => {
  setActivity("Keyboard test — injecting trusted Tab presses and diffing forced focus styles…");
  const res = await send({ type: "GUIDED_KEYBOARD_TEST", tabId });
  if (!res?.ok) { setStatus(res?.error || "Keyboard test failed."); return; }
  const stops = res.stops || [];
  const noFocus = stops.filter(s => s.focusCheck?.checked && !s.focusCheck.visible);
  const unchecked = stops.filter(s => !s.focusCheck?.checked);
  const traps = res.findings || [];
  gtRow(
    `Keyboard: ${stops.length} tab stop(s) — ${noFocus.length} without visible focus, ${traps.length} trap(s)`,
    `${res.cycled ? "focus order cycled cleanly" : res.trapped ? "walk STOPPED at a trap Escape could not free" : "walk ended"}${unchecked.length ? `; ${unchecked.length} stop(s) unverifiable via CDP` : ""}`,
    noFocus.length > 0 || traps.length > 0
  );
  setStatus("Keyboard test done.");
}));

$("btn-gt-reflow").addEventListener("click", () => runOp("guided", async () => {
  setActivity("Reflow test — emulating a 320 px viewport…");
  const res = await send({ type: "GUIDED_REFLOW_TEST", tabId });
  if (!res?.ok) { setStatus(res?.error || "Reflow test failed."); return; }
  gtRow(
    res.horizontalScroll
      ? `Reflow: horizontal scroll at 320 px (${res.scrollWidth}px > ${res.clientWidth}px)`
      : "Reflow: no horizontal scroll at 320 px",
    res.horizontalScroll ? `${(res.offenders || []).length} overflowing element chain(s)` : "page reflows cleanly",
    !!res.horizontalScroll
  );
  setStatus("Reflow test done.");
}));

$("btn-gt-report").addEventListener("click", async () => {
  const res = await send({ type: "GUIDED_REPORT", tabId });
  setStatus(res?.ok ? "Guided report opened in a new tab." : (res?.error || "Report failed."));
});

$("btn-highlight").addEventListener("click", async () => {
  const res = await send({ type: "HIGHLIGHT_ISSUES", tabId, options: readSettings() });
  setStatus(res?.ok ? "Issues highlighted on the page." : (res?.error || "Highlight failed."));
});
$("btn-clear-highlight").addEventListener("click", async () => {
  await send({ type: "CLEAR_HIGHLIGHTS", tabId });
  setStatus("Highlights cleared.");
});
btnRecover.addEventListener("click", async () => {
  setActivity("Rebuilding report from the interrupted crawl…");
  const res = await send({ type: "RECOVER_CHECKPOINT" });
  setActivity(null);
  setStatus(res?.ok ? "Recovered report opened." : (res?.error || "Recovery failed."));
  refresh();
});
btnReport.addEventListener("click", () => {
  if (lastReportId) chrome.tabs.create({ url: chrome.runtime.getURL(`report/report.html?id=${lastReportId}`) });
});

$("btn-force-stop").addEventListener("click", async () => {
  $("btn-force-stop").hidden = true;
  const res = await send({ type: "WORKFLOW_FORCE_STOP", tabId });
  setStatus(res?.ok ? "Scan force-stopped — its result will be discarded. Recording continues." : (res?.error || "Force stop failed."));
  refresh();
});

// Double-click a timeline row → rename the step (axe's state-rename,
// locally). The live "Analyzing…" row carries no stepId and is ignored.
$("timeline").addEventListener("dblclick", async (e) => {
  const li = e.target.closest ? e.target.closest("li[data-step-id]") : null;
  if (!li || !li.dataset.stepId) return;
  const name = prompt("Step name:", li.dataset.detail || "");
  if (name === null) return;  // cancelled
  const res = await send({ type: "WORKFLOW_RENAME_STEP", tabId, stepId: li.dataset.stepId, name });
  setStatus(res?.ok ? "Step renamed." : (res?.error || "Rename failed."));
  refresh();
});

loadSettings().then(refresh);
const polling = setInterval(refresh, 1000);
window.addEventListener("unload", () => clearInterval(polling));
