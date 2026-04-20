const reportId = new URLSearchParams(location.search).get("id");

function send(msg) {
  return new Promise(resolve => chrome.runtime.sendMessage(msg, resolve));
}

function el(tag, props = {}, children = []) {
  const e = document.createElement(tag);
  for (const [k, v] of Object.entries(props)) {
    if (k === "class") e.className = v;
    else if (k === "html") e.innerHTML = v;
    else if (k.startsWith("on") && typeof v === "function") e.addEventListener(k.slice(2), v);
    else e.setAttribute(k, v);
  }
  for (const c of children) {
    if (c == null) continue;
    e.appendChild(typeof c === "string" ? document.createTextNode(c) : c);
  }
  return e;
}

function escape(s) {
  return String(s ?? "").replace(/[&<>"']/g, ch => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function stringifyData(d) {
  if (d === null || d === undefined) return "";
  if (typeof d === "string") return d;
  try { return JSON.stringify(d, null, 2); } catch { return String(d); }
}

// Render a check group (any/all/none) as a small table — every field
// axe reports per check is surfaced: id, impact, message, data, relatedNodes.
function renderCheckGroup(label, checks) {
  if (!checks || !checks.length) return null;
  const wrap = el("div", { class: "check-group" });
  wrap.appendChild(el("div", { class: "check-group-label" }, [`${label} (${checks.length})`]));
  for (const c of checks) {
    const row = el("div", { class: "check-row" });
    row.appendChild(el("div", { class: "check-head" }, [
      el("span", { class: "check-id" }, [c.id || ""]),
      c.impact ? el("span", { class: `impact-${c.impact} pill` }, [c.impact]) : null
    ]));
    if (c.message) row.appendChild(el("div", { class: "check-msg" }, [c.message]));
    if (c.data !== undefined && c.data !== null && c.data !== "") {
      row.appendChild(el("div", { class: "check-data-label" }, ["data:"]));
      row.appendChild(el("pre", { class: "check-data" }, [stringifyData(c.data)]));
    }
    if (c.relatedNodes && c.relatedNodes.length) {
      row.appendChild(el("div", { class: "check-data-label" }, [`related nodes (${c.relatedNodes.length}):`]));
      const list = el("ul", { class: "related-list" });
      for (const rn of c.relatedNodes) {
        const li = el("li");
        const tgt = Array.isArray(rn.target) ? rn.target.join(" ") : String(rn.target || "");
        if (tgt) li.appendChild(el("code", { class: "related-target" }, [tgt]));
        if (rn.html) li.appendChild(el("pre", { class: "related-html" }, [rn.html]));
        list.appendChild(li);
      }
      row.appendChild(list);
    }
    wrap.appendChild(row);
  }
  return wrap;
}

function renderNodeDetails(i) {
  const box = el("div", { class: "issue-details" });
  box.appendChild(el("div", { class: "kv" }, [
    el("span", { class: "k" }, ["Rule:"]),
    el("span", { class: "v" }, [`${i.rule_id}${i.rule_impact ? ` · ${i.rule_impact}` : ""}`])
  ]));
  if (i.rule_description) {
    box.appendChild(el("div", { class: "kv" }, [
      el("span", { class: "k" }, ["Description:"]),
      el("span", { class: "v" }, [i.rule_description])
    ]));
  }
  if (i.rule_help) {
    box.appendChild(el("div", { class: "kv" }, [
      el("span", { class: "k" }, ["Help:"]),
      el("span", { class: "v" }, [i.rule_help])
    ]));
  }
  if (i.help_url) {
    const link = el("a", { href: i.help_url, target: "_blank", rel: "noopener" }, [i.help_url]);
    box.appendChild(el("div", { class: "kv" }, [
      el("span", { class: "k" }, ["Help URL:"]),
      el("span", { class: "v" }, [link])
    ]));
  }
  if (i.rule_tags) {
    box.appendChild(el("div", { class: "kv" }, [
      el("span", { class: "k" }, ["Tags:"]),
      el("span", { class: "v" }, [i.rule_tags])
    ]));
  }

  if (i.selector) {
    box.appendChild(el("div", { class: "kv" }, [
      el("span", { class: "k" }, ["Selector(s):"]),
      el("code", { class: "v mono" }, [i.selector])
    ]));
  }
  if (i.ancestry) {
    box.appendChild(el("div", { class: "kv" }, [
      el("span", { class: "k" }, ["Ancestry:"]),
      el("code", { class: "v mono" }, [i.ancestry])
    ]));
  }
  if (i.xpath) {
    box.appendChild(el("div", { class: "kv" }, [
      el("span", { class: "k" }, ["XPath:"]),
      el("code", { class: "v mono" }, [i.xpath])
    ]));
  }
  if (i.html_snippet) {
    box.appendChild(el("div", { class: "k" }, ["HTML:"]));
    box.appendChild(el("pre", { class: "html-snippet" }, [i.html_snippet]));
  }
  if (i.failure_summary) {
    box.appendChild(el("div", { class: "k" }, ["Failure summary:"]));
    box.appendChild(el("pre", { class: "failure-summary" }, [i.failure_summary]));
  }

  const any = renderCheckGroup("any (at least one must pass)", i.checks_any);
  const all = renderCheckGroup("all (every must pass)", i.checks_all);
  const none = renderCheckGroup("none (must all fail)", i.checks_none);
  if (any) box.appendChild(any);
  if (all) box.appendChild(all);
  if (none) box.appendChild(none);

  return box;
}

(async () => {
  const res = await send({ type: "GET_REPORT", reportId });
  const report = res?.report;
  if (!report) {
    document.body.innerHTML = "<div class='wrap' style='padding:40px'><h1>Report not available</h1><p>The report has expired. Run a new scan from the popup.</p></div>";
    return;
  }

  let modeLabel;
  if (report.meta.mode === "single") {
    modeLabel = "Single-page scan";
  } else {
    const breakdown = report.meta.depthStats
      ? " · " + Object.entries(report.meta.depthStats)
          .sort((a, b) => Number(a[0]) - Number(b[0]))
          .map(([d, n]) => `d${d}:${n}`).join(" ")
      : "";
    modeLabel = `Multi-page scan (depth ${report.meta.crawlDepth ?? 1}, max ${report.meta.maxUrls ?? report.meta.totalPages})${breakdown}`;
  }
  document.getElementById("meta").textContent =
    `${modeLabel} · ${report.meta.totalPages} page(s) · generated ${new Date(report.meta.generatedAt).toLocaleString()} · seed: ${report.meta.seedUrl}`;

  // ── Stats tiles ──
  const totalViolations = report.issueRows.length;
  const byImpact = { critical: 0, serious: 0, moderate: 0, minor: 0 };
  for (const i of report.issueRows) if (byImpact[i.impact] != null) byImpact[i.impact]++;
  const passedCriteria = report.summaryRows.filter(r => r.status === "PASS").length;
  const failedCriteria = report.summaryRows.filter(r => r.status === "FAIL").length;

  const passNodeCount = (report.passRows || []).length;
  const incompleteNodeCount = (report.incompleteRows || []).length;
  const inapplicableRuleCount = (report.inapplicableRows || []).length;

  const stats = document.getElementById("stats");
  stats.appendChild(makeStat("Pages scanned", report.meta.totalPages));
  stats.appendChild(makeStat("Templates", report.meta.totalTemplates ?? (report.templatesRows || []).length));
  stats.appendChild(makeStat("Violations (issues)", totalViolations));
  stats.appendChild(makeStat("Passes (node-level)", passNodeCount));
  stats.appendChild(makeStat("Incomplete", incompleteNodeCount));
  stats.appendChild(makeStat("Inapplicable rules", inapplicableRuleCount));
  stats.appendChild(makeStat("Criteria passed", passedCriteria));
  stats.appendChild(makeStat("Criteria failed", failedCriteria, "fail"));
  stats.appendChild(makeStat("Critical", byImpact.critical, "critical"));
  stats.appendChild(makeStat("Serious", byImpact.serious, "serious"));
  stats.appendChild(makeStat("Moderate", byImpact.moderate, "moderate"));
  stats.appendChild(makeStat("Minor", byImpact.minor, "minor"));

  document.getElementById("incomplete-count").textContent = `(${incompleteNodeCount})`;
  document.getElementById("passes-count").textContent = `(${passNodeCount})`;
  document.getElementById("inapplicable-count").textContent = `(${inapplicableRuleCount})`;

  // ── Summary table ──
  const sumBody = document.querySelector("#summary-table tbody");
  for (const r of report.summaryRows) {
    const tr = el("tr", {}, [
      el("td", {}, [r.wcag_criterion]),
      el("td", {}, [r.level]),
      el("td", {}, [r.name]),
      el("td", { class: r.status === "PASS" ? "pass" : "fail" }, [r.status]),
      el("td", {}, [String(r.pages_passed)]),
      el("td", {}, [String(r.pages_failed)]),
      el("td", {}, [String(r.total_violations)])
    ]);
    sumBody.appendChild(tr);
  }

  // ── Templates table ──
  const templatesBody = document.querySelector("#templates-table tbody");
  for (const t of report.templatesRows || []) {
    const sampleA = el("a", { href: t.sample_url, target: "_blank", rel: "noopener" }, [t.sample_url]);
    const sampleCell = el("td", { class: "url", title: t.sample_url });
    sampleCell.appendChild(sampleA);

    const mainRow = el("tr", { class: "template-row" });
    mainRow.appendChild(el("td", {}, [t.template_id]));
    mainRow.appendChild(el("td", {}, [t.url_cluster]));
    mainRow.appendChild(el("td", {}, [String(t.page_count)]));
    mainRow.appendChild(sampleCell);
    mainRow.appendChild(el("td", {}, [String(t.total_violations)]));
    mainRow.appendChild(el("td", { class: "impact-critical" }, [String(t.critical)]));
    mainRow.appendChild(el("td", { class: "impact-serious" }, [String(t.serious)]));
    mainRow.appendChild(el("td", { class: "impact-moderate" }, [String(t.moderate)]));
    mainRow.appendChild(el("td", { class: "impact-minor" }, [String(t.minor)]));
    mainRow.appendChild(el("td", {}, [String(t.unique_rules)]));

    const detailRow = el("tr", { class: "template-detail-row" });
    const detailCell = el("td", { colspan: "10" });
    const list = el("ul", { class: "template-pages" });
    for (const url of t.pages || []) {
      const li = el("li");
      li.appendChild(el("a", { href: url, target: "_blank", rel: "noopener" }, [url]));
      list.appendChild(li);
    }
    detailCell.appendChild(list);
    detailRow.appendChild(detailCell);

    mainRow.addEventListener("click", () => mainRow.classList.toggle("expanded"));
    templatesBody.appendChild(mainRow);
    templatesBody.appendChild(detailRow);
  }

  // ── Pages table (expand to show scan metadata) ──
  const pagesBody = document.querySelector("#pages-table tbody");
  for (const p of report.pagesRows) {
    const a = el("a", { href: p.url, target: "_blank", rel: "noopener" }, [p.url]);
    const urlCell = el("td", { class: "url", title: p.url });
    urlCell.appendChild(a);
    const mainRow = el("tr", { class: "page-row" }, [
      urlCell,
      el("td", {}, [String(p.depth ?? "")]),
      el("td", {}, [p.source || ""]),
      el("td", {}, [p.template_id || ""]),
      el("td", {}, [p.url_cluster || ""]),
      el("td", {}, [p.status]),
      el("td", {}, [String(p.violations)]),
      el("td", {}, [String(p.passes)]),
      el("td", {}, [String(p.incomplete)]),
      el("td", {}, [String(p.inapplicable)]),
      el("td", {}, [p.error || ""])
    ]);

    const detailRow = el("tr", { class: "page-detail-row" });
    const detailCell = el("td", { colspan: "11" });
    const grid = el("div", { class: "kv-grid" }, [
      kv("axe version", p.axe_version),
      kv("scan duration (ms)", p.scan_duration_ms),
      kv("text hash", p.text_hash),
      kv("text length", p.text_length),
      kv("signature items", p.signature_items),
      kv("headings", p.elem_headings),
      kv("sections", p.elem_sections),
      kv("forms", p.elem_forms),
      kv("aria roles", p.elem_aria_roles),
      kv("links", p.elem_links),
      kv("images", p.elem_images),
      kv("buttons", p.elem_buttons),
      kv("inputs", p.elem_inputs),
      kv("violation rules", p.violation_rules),
      kv("pass rules", p.pass_rules),
      kv("incomplete rules", p.incomplete_rules),
      kv("inapplicable rules", p.inapplicable_rules)
    ]);
    detailCell.appendChild(grid);
    detailRow.appendChild(detailCell);

    mainRow.addEventListener("click", () => mainRow.classList.toggle("expanded"));
    pagesBody.appendChild(mainRow);
    pagesBody.appendChild(detailRow);
  }

  // ── Violations / Issues ──
  const issuesBody = document.querySelector("#issues-table tbody");
  for (const i of report.issueRows) {
    const mainRow = el("tr", { class: "issue-row" });
    const urlA = el("a", { href: i.url, target: "_blank", rel: "noopener" }, [i.url]);
    const urlCell = el("td", { class: "url", title: i.url });
    urlCell.appendChild(urlA);
    mainRow.appendChild(urlCell);
    mainRow.appendChild(el("td", {}, [i.wcag_criterion]));
    mainRow.appendChild(el("td", {}, [i.wcag_level]));
    mainRow.appendChild(el("td", {}, [i.rule_id]));
    mainRow.appendChild(el("td", { class: `impact-${i.impact || "minor"}` }, [i.impact || ""]));
    mainRow.appendChild(el("td", {}, [i.failure_summary || i.wcag_name || i.rule_description || ""]));

    const detailRow = el("tr", { class: "issue-detail-row" });
    const detailCell = el("td", { colspan: "6" });
    detailCell.appendChild(renderNodeDetails(i));
    detailRow.appendChild(detailCell);

    mainRow.addEventListener("click", () => mainRow.classList.toggle("expanded"));
    issuesBody.appendChild(mainRow);
    issuesBody.appendChild(detailRow);
  }

  // ── Incomplete ──
  const incBody = document.querySelector("#incomplete-table tbody");
  for (const r of report.incompleteRows || []) {
    const mainRow = el("tr", { class: "issue-row" });
    const urlA = el("a", { href: r.url, target: "_blank", rel: "noopener" }, [r.url]);
    const urlCell = el("td", { class: "url", title: r.url });
    urlCell.appendChild(urlA);
    mainRow.appendChild(urlCell);
    mainRow.appendChild(el("td", {}, [r.rule_id]));
    mainRow.appendChild(el("td", { class: `impact-${r.rule_impact || "minor"}` }, [r.rule_impact || ""]));
    mainRow.appendChild(el("td", {}, [r.rule_tags || ""]));
    mainRow.appendChild(el("td", {}, [r.rule_description || ""]));

    const detailRow = el("tr", { class: "issue-detail-row" });
    const detailCell = el("td", { colspan: "5" });
    detailCell.appendChild(renderNodeDetails({
      rule_id: r.rule_id,
      rule_impact: r.rule_impact,
      rule_description: r.rule_description,
      rule_help: r.rule_help,
      rule_tags: r.rule_tags,
      help_url: r.rule_help_url,
      selector: r.node_target,
      ancestry: r.node_ancestry,
      xpath: r.node_xpath,
      html_snippet: r.node_html,
      failure_summary: r.node_failure_summary,
      impact: r.node_impact,
      checks_any: r.checks_any,
      checks_all: r.checks_all,
      checks_none: r.checks_none
    }));
    detailRow.appendChild(detailCell);

    mainRow.addEventListener("click", () => mainRow.classList.toggle("expanded"));
    incBody.appendChild(mainRow);
    incBody.appendChild(detailRow);
  }

  // ── Passes (collapsed by default — can be large) ──
  const passBody = document.querySelector("#passes-table tbody");
  for (const r of report.passRows || []) {
    passBody.appendChild(el("tr", {}, [
      el("td", { class: "url", title: r.url }, [r.url]),
      el("td", {}, [r.rule_id]),
      el("td", {}, [r.rule_tags || ""]),
      el("td", {}, [r.rule_description || ""])
    ]));
  }
  document.getElementById("toggle-passes").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("passes-table").classList.toggle("hidden");
  });

  // ── Inapplicable (collapsed by default) ──
  const inapBody = document.querySelector("#inapplicable-table tbody");
  for (const r of report.inapplicableRows || []) {
    inapBody.appendChild(el("tr", {}, [
      el("td", { class: "url", title: r.url }, [r.url]),
      el("td", {}, [r.rule_id]),
      el("td", {}, [r.rule_tags || ""]),
      el("td", {}, [r.rule_description || ""])
    ]));
  }
  document.getElementById("toggle-inapplicable").addEventListener("click", (e) => {
    e.preventDefault();
    document.getElementById("inapplicable-table").classList.toggle("hidden");
  });

  // ── Scan Environment ──
  const envBody = document.querySelector("#env-table tbody");
  for (const r of report.envRows || []) {
    const win = r.window_width && r.window_height ? `${r.window_width}×${r.window_height}` : "";
    const orient = [r.orientation_type, r.orientation_angle !== "" ? `${r.orientation_angle}°` : ""].filter(Boolean).join(" ");
    envBody.appendChild(el("tr", {}, [
      el("td", { class: "url", title: r.url }, [r.url]),
      el("td", {}, [r.axe_version || ""]),
      el("td", {}, [String(r.scan_duration_ms ?? "")]),
      el("td", {}, [r.scan_started_at || ""]),
      el("td", {}, [win]),
      el("td", {}, [orient]),
      el("td", { class: "user-agent", title: r.user_agent }, [r.user_agent || ""])
    ]));
  }

  document.getElementById("btn-download").addEventListener("click", async () => {
    const r = await send({ type: "DOWNLOAD_CSV", reportId });
    if (!r?.ok) alert(r?.error || "Download failed");
  });

  // Full raw payload as JSON — the nuclear option. Everything axe reported,
  // plus all derived rows, plus the original per-page response.
  document.getElementById("btn-download-json").addEventListener("click", () => {
    const json = JSON.stringify(report, null, 2);
    const blob = new Blob([json], { type: "application/json" });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    const host = (() => { try { return new URL(report.meta.seedUrl).hostname; } catch { return "site"; } })();
    a.download = `enableuser-report-${host}-${report.meta.generatedAt.replace(/[:.]/g, "-")}.json`;
    document.body.appendChild(a); a.click(); document.body.removeChild(a);
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  });
})();

function makeStat(label, value, cls = "") {
  const e = document.createElement("div");
  e.className = "stat " + cls;
  const l = document.createElement("div");
  l.className = "label"; l.textContent = label;
  const v = document.createElement("div");
  v.className = "value"; v.textContent = String(value);
  e.appendChild(l); e.appendChild(v);
  return e;
}

function kv(label, value) {
  const wrap = document.createElement("div");
  wrap.className = "kv-cell";
  const l = document.createElement("div");
  l.className = "kv-cell-label"; l.textContent = label;
  const v = document.createElement("div");
  v.className = "kv-cell-value"; v.textContent = String(value ?? "");
  wrap.appendChild(l); wrap.appendChild(v);
  return wrap;
}
