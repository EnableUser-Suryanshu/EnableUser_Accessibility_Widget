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

const BLANK_IMG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

async function readScreenshotFromStorage(id) {
  try {
    const key = `shot:${id}`;
    const stored = await chrome.storage.local.get(key);
    return stored[key] || null;
  } catch (err) {
    console.warn("[EU] storage.local read failed for screenshot", id, err);
    return null;
  }
}

const screenshotObserver = ("IntersectionObserver" in window)
  ? new IntersectionObserver((entries, obs) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        const img = entry.target;
        obs.unobserve(img);
        loadScreenshot(img);
      }
    }, { rootMargin: "400px 0px" })
  : null;

async function loadScreenshot(img) {
  const id = img.getAttribute("data-shot-id");
  if (!id || img.getAttribute("data-loaded") === "1") return;
  img.setAttribute("data-loaded", "loading");
  try {
    let entry = await readScreenshotFromStorage(id);
    if (!entry?.dataUrl) {
      const res = await send({ type: "GET_SCREENSHOT", id });
      if (res?.ok && res.dataUrl) entry = { dataUrl: res.dataUrl };
    }
    if (entry?.dataUrl) {
      img.src = entry.dataUrl;
      img.setAttribute("data-loaded", "1");
    } else {
      img.setAttribute("data-loaded", "error");
      img.alt = "screenshot unavailable";
      img.classList.add("screenshot-missing");
    }
  } catch (err) {
    console.warn("[EU] screenshot fetch failed", err);
    img.setAttribute("data-loaded", "error");
  }
}

function renderScreenshot(shot, caption) {
  if (!shot?.id) return null;
  const wrap = el("div", { class: "screenshot-wrap" });
  wrap.appendChild(el("div", { class: "check-group-label" }, [caption || "Full-page screenshot"]));
  const img = el("img", {
    class: "screenshot-thumb",
    src: BLANK_IMG,
    "data-shot-id": shot.id,
    alt: "full-page screenshot (loading)"
  });
  img.addEventListener("click", () => {
    img.classList.toggle("expanded");
    if (img.getAttribute("data-loaded") !== "1") loadScreenshot(img);
  });
  wrap.appendChild(img);
  if (screenshotObserver) screenshotObserver.observe(img);
  else loadScreenshot(img);
  return wrap;
}

function renderElementShot(id) {
  if (!id) return el("span", { class: "muted" }, ["—"]);
  const img = el("img", {
    class: "screenshot-thumb element-shot-thumb",
    src: BLANK_IMG,
    "data-shot-id": id,
    alt: "issue element screenshot (loading)"
  });
  img.addEventListener("click", () => {
    img.classList.toggle("expanded");
    if (img.getAttribute("data-loaded") !== "1") loadScreenshot(img);
  });
  if (screenshotObserver) screenshotObserver.observe(img);
  else loadScreenshot(img);
  return img;
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
    document.body.innerHTML = "<div class='wrap' style='padding:40px'><h1>Report not available</h1><p>This report could not be found or is no longer stored in local storage. Run a new scan from the popup.</p></div>";
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
  const _summaryHeading = document.getElementById("summary-heading");
  if (_summaryHeading && report.meta.profileLabel) _summaryHeading.textContent = `${report.meta.profileLabel} — Criterion Status`;

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
  const mediaTotal = (report.mediaRows || []).length;
  if (mediaTotal > 0) stats.appendChild(makeStat("Media & docs", mediaTotal));
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

  // ── Conformance by Standard ──
  // Each row expands to show which clauses failed, with a count per clause.
  const profilesBody = document.querySelector("#profiles-table tbody");
  const activeProfile = report.meta.profile || "wcag21aa";
  for (const pr of report.profilesRows || []) {
    const isActive = pr.profile_key === activeProfile;
    const statusClass =
      pr.conformance_status === "Fully conformant" ? "pass" :
      pr.conformance_status === "Does not conform" ? "fail" : "";
    const mainRow = el("tr", { class: "profile-row" + (isActive ? " profile-active" : "") });
    const labelCell = el("td", {}, [pr.profile_label + (isActive ? " ★" : "")]);
    mainRow.appendChild(labelCell);
    mainRow.appendChild(el("td", {}, [String(pr.applicable_criteria)]));
    mainRow.appendChild(el("td", { class: "pass" }, [String(pr.passed_criteria)]));
    mainRow.appendChild(el("td", { class: pr.failed_criteria > 0 ? "fail" : "" }, [String(pr.failed_criteria)]));
    mainRow.appendChild(el("td", {}, [String(pr.total_violations)]));
    mainRow.appendChild(el("td", { class: statusClass }, [pr.conformance_status]));

    const detailRow = el("tr", { class: "profile-detail-row" });
    const detailCell = el("td", { colspan: "6" });
    if (pr.failing_clauses && pr.failing_clauses.length) {
      const grid = el("table", { class: "failing-clauses" });
      grid.appendChild(el("thead", {}, [
        el("tr", {}, [
          el("th", {}, ["Clause"]), el("th", {}, ["WCAG SC"]),
          el("th", {}, ["Name"]), el("th", {}, ["Level"]),
          el("th", {}, ["Pages Failed"]), el("th", {}, ["Total Violations"])
        ])
      ]));
      const body = el("tbody");
      for (const f of pr.failing_clauses) {
        body.appendChild(el("tr", {}, [
          el("td", { class: "mono" }, [f.clause || ""]),
          el("td", {}, [f.wcag || ""]),
          el("td", {}, [f.name || ""]),
          el("td", {}, [f.level || ""]),
          el("td", { class: "fail" }, [String(f.pages_failed)]),
          el("td", { class: "fail" }, [String(f.total_violations)])
        ]));
      }
      grid.appendChild(body);
      detailCell.appendChild(grid);
    } else {
      detailCell.appendChild(el("p", { class: "muted" }, ["No failing clauses in this profile."]));
    }
    detailRow.appendChild(detailCell);

    mainRow.addEventListener("click", () => mainRow.classList.toggle("expanded"));
    profilesBody.appendChild(mainRow);
    profilesBody.appendChild(detailRow);
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

  // ── Media & Documents ──
  renderMediaSection(report);

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

  // ── Screenshots ──
  const screenshotsSection = document.getElementById("screenshots-section");
  const screenshotsGrid = document.getElementById("screenshots-grid");
  if (screenshotsSection && screenshotsGrid) {
    let count = 0;
    for (const p of report.pages || []) {
      if (p.screenshot?.id) {
        count++;
        const card = el("div", { class: "screenshot-card" });
        const caption = el("div", { class: "screenshot-caption" }, [
          el("div", { class: "screenshot-title" }, [p.title || "Untitled"]),
          el("a", { class: "screenshot-url", href: p.url, target: "_blank", rel: "noopener" }, [p.url])
        ]);
        card.appendChild(caption);
        const imgWrap = renderScreenshot(p.screenshot);
        if (imgWrap) {
          card.appendChild(imgWrap);
          screenshotsGrid.appendChild(card);
        }
      }
    }
    if (count > 0) {
      screenshotsSection.classList.remove("hidden");
    }
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
    mainRow.appendChild(el("td", { class: "element-shot-cell" }, [renderElementShot(i.elementShotId)]));
    mainRow.appendChild(el("td", {}, [i.failure_summary || i.wcag_name || i.rule_description || ""]));

    const detailRow = el("tr", { class: "issue-detail-row" });
    const detailCell = el("td", { colspan: "7" });
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

  document.getElementById("btn-download-xlsx").addEventListener("click", async () => {
    const btn = document.getElementById("btn-download-xlsx");
    const prev = btn.textContent;
    btn.disabled = true; btn.textContent = "Preparing…";
    const r = await send({ type: "DOWNLOAD_REPORT_XLSX", reportId });
    btn.disabled = false; btn.textContent = prev;
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

// ── Media & Documents ────────────────────────────────────────────────────
// Every <video>, <audio>, embedded video iframe, and linked PDF/Excel/Word/
// PowerPoint with its detected issues. Per-item rows expand to show the
// full issue list, WCAG mapping, and context excerpt.

const MEDIA_RULE_META = {
  "media-video-captions":         { wcag: "1.2.2", level: "A",  title: "Captions missing",             impact: "serious" },
  "media-video-audio-description":{ wcag: "1.2.5", level: "AA", title: "Audio description (review)",   impact: "moderate" },
  "media-video-autoplay":         { wcag: "1.4.2", level: "A",  title: "Autoplay without pause",       impact: "serious" },
  "media-video-controls":         { wcag: "2.1.1", level: "A",  title: "No controls (review)",         impact: "moderate" },
  "media-video-name":             { wcag: "4.1.2", level: "A",  title: "Missing accessible name",      impact: "serious" },
  "media-audio-transcript":       { wcag: "1.2.1", level: "A",  title: "Transcript not found (review)",impact: "moderate" },
  "media-audio-autoplay":         { wcag: "1.4.2", level: "A",  title: "Audio autoplays",              impact: "serious" },
  "media-audio-name":             { wcag: "4.1.2", level: "A",  title: "Missing accessible name",      impact: "serious" },
  "media-iframe-video-title":     { wcag: "4.1.2", level: "A",  title: "Iframe missing title",         impact: "serious" },
  "media-iframe-video-title-generic": { wcag: "4.1.2", level: "A", title: "Generic vendor title",      impact: "moderate" },
  "media-doc-link-purpose":       { wcag: "2.4.4", level: "A",  title: "Link purpose unclear",         impact: "serious" },
  "media-doc-type-hint":          { wcag: "2.4.4", level: "A",  title: "File type not declared",       impact: "minor" },
  "media-doc-size-hint":          { wcag: "—",     level: "—",  title: "File size not declared",       impact: "minor" },
  "media-doc-new-tab-notice":     { wcag: "3.2.2", level: "AA", title: "Opens new tab without notice", impact: "minor" },
  "media-pdf-manual-audit":       { wcag: "1.3.1", level: "A",  title: "PDF needs manual audit",       impact: "review" },
  "media-spreadsheet-manual-audit":{ wcag: "1.3.1", level: "A", title: "Spreadsheet needs manual audit",impact: "review" },
  "media-document-manual-audit":  { wcag: "1.3.1", level: "A",  title: "Document needs manual audit",  impact: "review" },
  "media-presentation-manual-audit":{ wcag: "1.3.1", level: "A",title: "Presentation needs manual audit",impact: "review" },
  // v13.1 — structural PDF audit findings emitted by lib/pdf-audit.js.
  "pdf-untagged":                 { wcag: "1.3.1", level: "A",  title: "PDF not tagged",               impact: "serious" },
  "pdf-missing-struct-tree":      { wcag: "1.3.1", level: "A",  title: "No PDF structure tree",        impact: "serious" },
  "pdf-missing-lang":             { wcag: "3.1.1", level: "A",  title: "PDF missing /Lang",            impact: "moderate" },
  "pdf-missing-title":            { wcag: "2.4.2", level: "A",  title: "PDF missing /Title",           impact: "moderate" },
  // v0.2.2 — structural Office audit findings emitted by lib/office-audit.js.
  "office-missing-title":         { wcag: "2.4.2", level: "A",  title: "Office doc missing title",     impact: "moderate" },
  "office-missing-language":      { wcag: "3.1.1", level: "A",  title: "Office doc missing language",  impact: "moderate" },
  "docx-no-headings":             { wcag: "1.3.1", level: "A",  title: "Word doc has no headings",     impact: "serious" },
  "pptx-no-slides":               { wcag: "1.3.1", level: "A",  title: "PowerPoint has no slides",     impact: "serious" },
  "xlsx-no-sheets":               { wcag: "1.3.1", level: "A",  title: "Excel has no sheets",          impact: "serious" }
};

function ruleMeta(id) {
  return MEDIA_RULE_META[id] || { wcag: "—", level: "—", title: id, impact: "minor" };
}

function kindIcon(kind, subtype) {
  if (kind === "video")        return "▶";
  if (kind === "audio")        return "♪";
  if (kind === "iframe-video") return "▶";
  if (kind === "document") {
    if (subtype === "pdf") return "PDF";
    if (/^xls/.test(subtype) || subtype === "csv" || subtype === "ods") return "XLS";
    if (/^doc/.test(subtype) || subtype === "odt" || subtype === "rtf") return "DOC";
    if (/^ppt/.test(subtype) || subtype === "odp") return "PPT";
  }
  return "•";
}

function renderMediaSection(report) {
  const rows = report.mediaRows || [];
  const summary = report.mediaSummary || {};
  document.getElementById("media-count").textContent = `(${rows.length})`;

  const tiles = document.getElementById("media-tiles");
  const tileDefs = [
    ["Videos (HTML5)",    summary.videos || 0],
    ["Audio elements",    summary.audios || 0],
    ["Embedded players",  summary.iframeVideos || 0],
    ["Linked documents",  summary.documents || 0],
    ["PDFs",              summary.pdf || 0],
    ["Spreadsheets",      summary.spreadsheet || 0],
    ["Word docs",         summary.document || 0],
    ["Presentations",     summary.presentation || 0]
  ];
  const totalIssues =
    (summary.videoIssues || 0) + (summary.audioIssues || 0) +
    (summary.iframeIssues || 0) + (summary.documentIssues || 0);
  for (const [label, value] of tileDefs) {
    tiles.appendChild(makeStat(label, value));
  }
  tiles.appendChild(makeStat("Findings raised", totalIssues, totalIssues > 0 ? "fail" : ""));

  if (!rows.length) {
    const tbody = document.querySelector("#media-table tbody");
    tbody.appendChild(el("tr", {}, [
      el("td", { colspan: "5", class: "muted", style: "text-align:center;padding:24px" }, [
        "No media or document links detected on the scanned pages."
      ])
    ]));
    return;
  }

  // ── Kind filter chips ──
  const filtersEl = document.getElementById("media-filters");
  const kinds = Array.from(new Set(rows.map(r => r.kind)));
  const allChip = el("button", { class: "media-chip active", "data-kind": "__all" }, [`All (${rows.length})`]);
  filtersEl.appendChild(allChip);
  for (const k of kinds) {
    const count = rows.filter(r => r.kind === k).length;
    const label = k === "iframe-video" ? "Embedded players" : k.charAt(0).toUpperCase() + k.slice(1) + "s";
    filtersEl.appendChild(el("button", { class: "media-chip", "data-kind": k }, [`${label} (${count})`]));
  }

  const tbody = document.querySelector("#media-table tbody");
  const mainRows = [];

  for (const r of rows) {
    const kindCell = el("td", { class: "media-kind-cell" }, [
      el("span", { class: `media-badge media-badge-${r.kind}` }, [kindIcon(r.kind, r.subtype)]),
      el("span", { class: "media-type-label" }, [r.type_label || r.kind])
    ]);
    const urlDisplay = r.media_url || "(inline)";
    const urlCell = el("td", { class: "url", title: urlDisplay });
    if (r.media_url) {
      urlCell.appendChild(el("a", { href: r.media_url, target: "_blank", rel: "noopener" }, [urlDisplay]));
    } else {
      urlCell.appendChild(document.createTextNode(urlDisplay));
    }
    const nameText = r.accessible_name || r.link_text || r.title_attr || "(no accessible name)";
    const nameCell = el("td", { class: r.accessible_name || r.link_text ? "" : "muted" }, [nameText]);
    const pageCell = el("td", { class: "url small", title: r.url }, [
      el("a", { href: r.url, target: "_blank", rel: "noopener" }, [r.url])
    ]);
    const issueCount = (r.issues || []).length;
    const issueCell = el("td", {
      class: issueCount ? (r.issues.some(id => /autoplay|captions|purpose|name|title$/.test(id)) ? "fail" : "warn") : "pass"
    }, [issueCount ? `${issueCount} issue${issueCount === 1 ? "" : "s"}` : "None"]);

    const mainRow = el("tr", { class: `media-row media-row-${r.kind}` }, [
      kindCell, urlCell, nameCell, pageCell, issueCell
    ]);
    const detailRow = el("tr", { class: "media-detail-row" });
    const detailCell = el("td", { colspan: "5" });
    detailCell.appendChild(renderMediaDetails(r));
    detailRow.appendChild(detailCell);

    mainRow.addEventListener("click", () => mainRow.classList.toggle("expanded"));
    mainRows.push({ mainRow, detailRow, kind: r.kind });
    tbody.appendChild(mainRow);
    tbody.appendChild(detailRow);
  }

  filtersEl.addEventListener("click", (e) => {
    const btn = e.target.closest(".media-chip");
    if (!btn) return;
    const kind = btn.getAttribute("data-kind");
    for (const c of filtersEl.querySelectorAll(".media-chip")) c.classList.remove("active");
    btn.classList.add("active");
    for (const { mainRow, detailRow, kind: rk } of mainRows) {
      const show = kind === "__all" || rk === kind;
      mainRow.style.display = show ? "" : "none";
      if (!show) {
        mainRow.classList.remove("expanded");
        detailRow.style.display = "none";
      } else {
        detailRow.style.display = "";
      }
    }
  });
}

function renderMediaDetails(r) {
  const box = el("div", { class: "issue-details" });

  // Attributes grid — presence/absence tiles for the fields that matter.
  const grid = el("div", { class: "kv-grid" });
  const addIf = (label, value) => { if (value !== "" && value !== null && value !== undefined) grid.appendChild(kv(label, value)); };
  addIf("Kind", r.type_label || r.kind);
  addIf("Source URL", r.media_url);
  addIf("On page", r.url);
  addIf("Accessible name", r.accessible_name);
  if (r.kind === "document") {
    addIf("Link text", r.link_text);
    addIf("Context", r.context);
    addIf("Format declared", formatBool(r.has_type_hint));
    addIf("Size declared", formatBool(r.has_size_hint));
    addIf("Opens new tab", formatBool(r.opens_in_new_tab));
    if (r.opens_in_new_tab) addIf("New-tab notice", formatBool(r.has_new_tab_notice));
    // v13.1 — PDF structural audit (if this is a PDF and auditing ran).
    if (r.pdfAudit && r.pdfAudit.ok) {
      const a = r.pdfAudit;
      addIf("PDF tagged", formatBool(a.tagged));
      addIf("Structure tree", formatBool(a.hasStructTree));
      addIf("PDF language", a.lang || "—");
      addIf("PDF title", a.title || "—");
      if (a.size) addIf("PDF size (bytes)", a.size);
    } else if (r.pdfAudit && !r.pdfAudit.ok) {
      addIf("PDF audit", `not performed — ${r.pdfAudit.error || "fetch failed"}`);
    }
    // v0.2.2 — structural Office audit (docx/xlsx/pptx).
    if (r.officeAudit && r.officeAudit.ok) {
      const a = r.officeAudit;
      addIf("Office format", (a.format || "").toUpperCase());
      addIf("Doc title", a.title || "—");
      addIf("Doc language", a.language || "—");
      if (a.subject) addIf("Doc subject", a.subject);
      if (a.creator) addIf("Doc creator", a.creator);
      if (a.format === "docx") {
        addIf("Has heading styles", a.hasHeadings === true ? "Yes" : a.hasHeadings === false ? "No" : "—");
      } else if (a.format === "xlsx") {
        addIf("Sheet count", a.sheetCount ?? "—");
      } else if (a.format === "pptx") {
        addIf("Slide count", a.slideCount ?? "—");
      }
      if (a.sizeBytes) addIf("File size (bytes)", a.sizeBytes);
    } else if (r.officeAudit && !r.officeAudit.ok) {
      addIf("Office audit", `not performed — ${r.officeAudit.reason || "fetch failed"}`);
    }
  }
  if (r.kind === "video") {
    addIf("Captions", formatBool(r.has_captions));
    addIf("Audio description", formatBool(r.has_descriptions));
    addIf("Controls", formatBool(r.has_controls));
    addIf("Autoplay", formatBool(r.autoplay));
    addIf("Muted", formatBool(r.muted));
    if (r.duration_seconds) addIf("Duration (s)", r.duration_seconds);
    if (Array.isArray(r.tracks) && r.tracks.length) {
      const trackList = r.tracks.map(t => `${t.kind}${t.srclang ? " (" + t.srclang + ")" : ""}${t.label ? ": " + t.label : ""}`).join(", ");
      addIf("Tracks", trackList);
    }
  }
  if (r.kind === "audio") {
    addIf("Transcript nearby", formatBool(r.has_transcript));
    addIf("Controls", formatBool(r.has_controls));
    addIf("Autoplay", formatBool(r.autoplay));
    if (r.duration_seconds) addIf("Duration (s)", r.duration_seconds);
  }
  if (r.kind === "iframe-video") {
    addIf("Vendor", r.vendor_label);
    addIf("Title attribute", r.title_attr);
    addIf("aria-label", r.aria_label);
  }
  box.appendChild(grid);

  // Findings — one card per rule id that was raised on this item.
  const issues = Array.isArray(r.issues) ? r.issues : [];
  if (issues.length) {
    box.appendChild(el("h4", { class: "media-findings-title" }, [`Findings (${issues.length})`]));
    const list = el("div", { class: "media-findings" });
    for (const id of issues) {
      const m = ruleMeta(id);
      list.appendChild(el("div", { class: "media-finding" }, [
        el("div", { class: "media-finding-head" }, [
          el("span", { class: `impact-${m.impact} pill` }, [m.impact]),
          el("span", { class: "media-finding-title" }, [m.title]),
          el("span", { class: "muted media-finding-wcag" }, [`WCAG ${m.wcag}${m.level && m.level !== "—" ? " (" + m.level + ")" : ""}`])
        ]),
        el("div", { class: "media-finding-rule mono muted" }, [id])
      ]));
    }
    box.appendChild(list);
  } else {
    box.appendChild(el("p", { class: "muted" }, ["No issues detected — automated checks passed. Note: for linked documents, a manual audit of the file itself is still required."]));
  }

  if (r.html_snippet) {
    box.appendChild(el("div", { class: "k" }, ["HTML:"]));
    box.appendChild(el("pre", { class: "html-snippet" }, [r.html_snippet]));
  }

  return box;
}

function formatBool(v) {
  if (v === true || v === "true") return "Yes";
  if (v === false || v === "false") return "No";
  if (v === "" || v == null) return "—";
  return String(v);
}
