// Renderer for report/inventory.html
// Fetches the inventory built by background.js (SCAN_INVENTORY) and populates
// stats / content-type / templates / sample / pages tables. Wires up the two
// download buttons that produce the scope.docx + inventory.xlsx deliverables.

import { deriveFromTags } from "../lib/wcag-tags.js";

const inventoryId = new URLSearchParams(location.search).get("id");

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
  return String(s ?? "").replace(/[&<>"']/g, ch =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
}

function stat(label, value, cls = "") {
  return el("div", { class: `stat ${cls}`.trim() }, [
    el("div", { class: "label" }, [label]),
    el("div", { class: "value" }, [String(value)])
  ]);
}

function boolCell(v) {
  return el("td", {}, [v ? "✓" : ""]);
}

function renderStats(inventory) {
  const host = document.getElementById("stats");
  host.innerHTML = "";
  const pages = inventory.pages || [];
  const ok = pages.filter(p => !p.error).length;
  const errs = pages.length - ok;
  const templates = (inventory.templates || []).length;
  const contentTypesDetected = Object.values(inventory.contentTypeSummary || {})
    .filter(n => n > 0).length;
  const testsTotal = (inventory.recommendedTestsUnion || []).length;
  const samplePages = (inventory.proposedSample || []).length;
  const spa = pages.filter(p => !p.error && p.pageType === "dynamic").length;
  const staticPages = pages.filter(p => !p.error && p.pageType === "static").length;

  host.appendChild(stat("Pages Scanned", ok));
  if (errs > 0) host.appendChild(stat("Unreachable", errs, "fail"));
  host.appendChild(stat("Templates", templates));
  host.appendChild(stat("Static / Dynamic", `${staticPages} / ${spa}`));
  host.appendChild(stat("Content Types", contentTypesDetected));
  host.appendChild(stat("Proposed Sample", samplePages));
  host.appendChild(stat("Manual Tests", testsTotal));
  host.appendChild(stat("Max URLs", inventory.meta?.maxUrls ?? "—"));
  host.appendChild(stat("Crawl Depth", inventory.meta?.crawlDepthLabel ?? inventory.meta?.crawlDepth ?? "—"));

  // Dedup transparency. Shows when multiple queue entries (e.g. /foo?from=x
  // and /foo?from=y) resolved to the same final URL and got merged into a
  // single inventory row. Zero on clean crawls; non-zero surfaces the fact
  // that some queued URLs were client-side-redirected onto an existing row.
  // The by_* breakdown (when present) attributes each collapse to the
  // signal that caused it: canonical link, settled URL, or queued URL.
  const d = inventory.dedupSummary;
  if (d && d.duplicates_collapsed > 0) {
    host.appendChild(stat("Duplicates Collapsed", d.duplicates_collapsed));
    if (d.by_canonical > 0) host.appendChild(stat("… by canonical link", d.by_canonical));
    if (d.by_final_url > 0) host.appendChild(stat("… by settled URL", d.by_final_url));
    if (d.by_queued_url > 0) host.appendChild(stat("… by queued URL", d.by_queued_url));
  }
}

function renderAuditStats(inventory) {
  const host = document.getElementById("audit-stats");
  if (!host) return;
  host.innerHTML = "";
  const a = inventory.corpusAudit || {};
  host.appendChild(stat("Pages Audited", a.pagesAudited ?? 0));
  host.appendChild(stat("Screenshots", a.pagesScreenshotted ?? 0));
  host.appendChild(stat("Violations", a.violations ?? 0, (a.violations || 0) > 0 ? "fail" : ""));
  host.appendChild(stat("Incomplete", a.incomplete ?? 0));
  host.appendChild(stat("Passes", a.passes ?? 0, "ok"));
  host.appendChild(stat("Inapplicable", a.inapplicable ?? 0));
}

function renderMeta(inventory) {
  const m = inventory.meta || {};
  const when = m.generatedAt ? new Date(m.generatedAt).toLocaleString() : "";
  const parts = [];
  if (m.seedUrl) parts.push(`Seed: ${m.seedUrl}`);
  if (m.seedHost) parts.push(`Host: ${m.seedHost}`);
  if (when) parts.push(`Generated: ${when}`);
  document.getElementById("meta").textContent = parts.join(" · ");
  document.title = `Scope — ${m.seedHost || "EnableUser"}`;
}

function renderContentTypes(inventory) {
  const tbody = document.querySelector("#content-types-table tbody");
  tbody.innerHTML = "";
  const entries = Object.entries(inventory.contentTypeSummary || {})
    .filter(([, n]) => n > 0)
    .sort((a, b) => b[1] - a[1]);
  if (!entries.length) {
    tbody.appendChild(el("tr", {}, [
      el("td", { colspan: "2", class: "muted" }, ["No specialised content types detected."])
    ]));
    return;
  }
  for (const [kind, n] of entries) {
    tbody.appendChild(el("tr", {}, [
      el("td", {}, [kind]),
      el("td", {}, [String(n)])
    ]));
  }
}

function renderRecommendedTestsDetail(tests) {
  if (!tests || !tests.length) {
    return el("div", { class: "muted" }, ["No specific manual tests flagged for this template."]);
  }
  const wrap = el("div", { class: "recommended-tests" });
  wrap.appendChild(el("div", { class: "check-group-label" },
    [`Recommended manual tests (${tests.length})`]));
  const tbl = el("table", { class: "failing-clauses" });
  tbl.appendChild(el("thead", {}, [
    el("tr", {}, [
      el("th", {}, ["Test"]),
      el("th", {}, ["Why"])
    ])
  ]));
  const tb = el("tbody");
  for (const t of tests) {
    tb.appendChild(el("tr", {}, [
      el("td", {}, [t.test || ""]),
      el("td", {}, [t.why || ""])
    ]));
  }
  tbl.appendChild(tb);
  wrap.appendChild(tbl);
  return wrap;
}

function renderComponentsDetail(components) {
  if (!components) return null;
  const wrap = el("div", { class: "components-detail" });
  wrap.appendChild(el("div", { class: "check-group-label" }, ["Component inventory (sample page)"]));

  // Forms with fields + labels
  if ((components.forms || []).length) {
    wrap.appendChild(el("div", {}, [el("strong", {}, [`Forms (${components.forms.length}):`])]));
    components.forms.slice(0, 10).forEach((f, idx) => {
      const meta = [];
      if (f.name) meta.push(`name="${f.name}"`);
      if (f.action) meta.push(`action="${f.action}"`);
      if (f.method) meta.push(`method=${f.method}`);
      const heading = el("div", { class: "form-heading" }, [
        `Form #${idx + 1} `, el("span", { class: "muted" }, [meta.join(" · ") || "(no metadata)"])
      ]);
      const fieldTbl = el("table", { class: "form-fields" });
      fieldTbl.appendChild(el("thead", {}, [el("tr", {}, [
        el("th", {}, ["Name"]), el("th", {}, ["Type"]),
        el("th", {}, ["Label"]), el("th", {}, ["Required"]), el("th", {}, ["Autocomplete"])
      ])]));
      const tb = el("tbody");
      for (const fld of (f.fields || [])) {
        tb.appendChild(el("tr", {}, [
          el("td", {}, [fld.name || ""]),
          el("td", {}, [fld.type || ""]),
          el("td", {}, [fld.label || el("span", { class: "muted" }, ["(no label)"])]),
          el("td", {}, [fld.required ? "Yes" : ""]),
          el("td", {}, [fld.autocomplete || ""])
        ]));
      }
      fieldTbl.appendChild(tb);
      wrap.appendChild(el("div", { class: "form-block" }, [heading, fieldTbl]));
    });
  }

  // Modals / dialogs with titles
  if ((components.modals || []).length) {
    wrap.appendChild(el("div", {}, [el("strong", {}, [`Modals / dialogs (${components.modals.length}):`])]));
    const ul = el("ul");
    for (const m of components.modals.slice(0, 30)) {
      ul.appendChild(el("li", {}, [
        m.role ? `[${m.role}] ` : "", m.label || el("span", { class: "muted" }, ["(no accessible name)"])
      ]));
    }
    wrap.appendChild(ul);
  }

  // Tab labels
  if ((components.tabs || []).length) {
    wrap.appendChild(el("div", {}, [el("strong", {}, [`Tabs (${components.tabs.length}):`])]));
    const ul = el("ul");
    for (const t of components.tabs.slice(0, 30)) {
      ul.appendChild(el("li", {}, [
        t.label || el("span", { class: "muted" }, ["(no label)"]), t.selected ? " — selected" : ""
      ]));
    }
    wrap.appendChild(ul);
  }

  // Menu items / nav links
  if ((components.menuItems || []).length) {
    wrap.appendChild(el("div", {}, [el("strong", {}, [`Menu / nav items (${components.menuItems.length}):`])]));
    const ul = el("ul", { class: "compact-list" });
    for (const m of components.menuItems.slice(0, 50)) {
      ul.appendChild(el("li", {}, [
        m.label || el("span", { class: "muted" }, ["(no text)"]),
        m.href ? ` → ${m.href}` : ""
      ]));
    }
    wrap.appendChild(ul);
  }

  // Carousels
  if ((components.carousels || []).length) {
    wrap.appendChild(el("div", {}, [el("strong", {}, [`Carousels (${components.carousels.length}):`])]));
    const ul = el("ul");
    components.carousels.forEach((c, i) => {
      ul.appendChild(el("li", {}, [
        `#${i + 1} — ${c.slideCount ?? 0} slide(s)${(c.slideHeadings || []).length ? `: ${c.slideHeadings.join(" · ")}` : ""}`
      ]));
    });
    wrap.appendChild(ul);
  }

  // Data tables
  if ((components.tables || []).length) {
    wrap.appendChild(el("div", {}, [el("strong", {}, [`Data tables (${components.tables.length}):`])]));
    const ul = el("ul");
    components.tables.forEach((t, i) => {
      const bits = [];
      if (t.caption) bits.push(`caption: "${t.caption}"`);
      if (t.summary) bits.push(`summary: "${t.summary}"`);
      if (t.rowCount) bits.push(`${t.rowCount} row(s)`);
      if ((t.columnHeaders || []).length) bits.push(`cols: ${t.columnHeaders.join(", ")}`);
      ul.appendChild(el("li", {}, [`#${i + 1} — ${bits.join(" · ") || "(no metadata)"}`]));
    });
    wrap.appendChild(ul);
  }

  // Buttons
  if ((components.buttons || []).length) {
    wrap.appendChild(el("div", {}, [el("strong", {}, [`Buttons / CTAs (${components.buttons.length}):`])]));
    const ul = el("ul", { class: "compact-list" });
    for (const b of components.buttons.slice(0, 40)) {
      ul.appendChild(el("li", {}, [b.label, b.disabled ? " (disabled)" : ""]));
    }
    wrap.appendChild(ul);
  }

  return wrap;
}

function renderAuditDetail(audit) {
  if (!audit || !Array.isArray(audit.violations)) return null;
  const wrap = el("div", { class: "audit-detail" });
  wrap.appendChild(el("div", { class: "check-group-label" }, [
    `Audit findings — ${(audit.violations || []).length} violation(s), ` +
    `${(audit.incomplete || []).length} incomplete, ` +
    `${(audit.passes || []).length} pass(es)`
  ]));
  if (!audit.violations?.length) {
    wrap.appendChild(el("div", { class: "muted" }, ["No violations on sample page."]));
    return wrap;
  }
  const tbl = el("table", { class: "failing-clauses" });
  tbl.appendChild(el("thead", {}, [el("tr", {}, [
    el("th", {}, ["Rule"]), el("th", {}, ["Impact"]),
    el("th", {}, ["Instances"]), el("th", {}, ["Description"])
  ])]));
  const tb = el("tbody");
  for (const v of audit.violations.slice(0, 50)) {
    tb.appendChild(el("tr", {}, [
      el("td", { class: "mono" }, [v.id || ""]),
      el("td", {}, [v.impact || ""]),
      el("td", {}, [String((v.nodes || []).length)]),
      el("td", {}, [v.description || v.help || ""])
    ]));
  }
  tbl.appendChild(tb);
  wrap.appendChild(tbl);
  return wrap;
}

// 1×1 transparent PNG — placeholder while the real screenshot loads. Prevents
// layout jump and gives the browser something to render in the <img> tag.
const BLANK_IMG =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNkYAAAAAYAAjCB0C8AAAAASUVORK5CYII=";

// Shared IntersectionObserver: when a screenshot thumbnail scrolls into view
// (or within 400px of it), fetch the full PNG data URL from the background
// service worker and swap it in. Previously the whole inventory payload
// shipped every dataUrl up-front, which blew past sendMessage's payload
// ceiling on large crawls. Now we ship only {id, bytes} references and pull
// each image on demand.
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

function loadScreenshot(img) {
  const id = img.getAttribute("data-shot-id");
  if (!id || img.getAttribute("data-loaded") === "1") return;
  img.setAttribute("data-loaded", "loading");
  send({ type: "GET_SCREENSHOT", id }).then(res => {
    if (res?.ok && res.dataUrl) {
      img.src = res.dataUrl;
      img.setAttribute("data-loaded", "1");
    } else {
      img.setAttribute("data-loaded", "error");
      img.alt = "screenshot unavailable (expired)";
      img.classList.add("screenshot-missing");
    }
  }).catch(err => {
    console.warn("[EU] screenshot fetch failed", err);
    img.setAttribute("data-loaded", "error");
  });
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
    // If the user clicks the placeholder before the observer fires (e.g. IO
    // not supported), force-load on interaction too.
    if (img.getAttribute("data-loaded") !== "1") loadScreenshot(img);
  });
  wrap.appendChild(img);
  if (screenshotObserver) screenshotObserver.observe(img);
  else loadScreenshot(img); // Fallback: no IntersectionObserver → load eagerly.
  return wrap;
}

function renderTemplates(inventory) {
  const tbody = document.querySelector("#templates-table tbody");
  tbody.innerHTML = "";
  const templates = inventory.templates || [];
  if (!templates.length) {
    tbody.appendChild(el("tr", {}, [
      el("td", { colspan: "5", class: "muted" }, ["No templates detected."])
    ]));
    return;
  }
  templates.forEach((t, i) => {
    const typeLabel = t.isSPA ? "dynamic (SPA)" : (t.sample_pageType || "static");
    // Templates now cluster by fingerprint alone, so a single template can
    // span multiple URL shapes. Show the primary cluster + a count of others.
    const extraClusters = Math.max(0, (t.cluster_count || 1) - 1);
    const clusterLabel = extraClusters > 0
      ? `${t.url_cluster || ""} (+${extraClusters} more URL cluster${extraClusters === 1 ? "" : "s"})`
      : (t.url_cluster || "");
    const row = el("tr", { class: "template-row" }, [
      el("td", { class: "mono" }, [t.template_id || ""]),
      el("td", {}, [`${clusterLabel}  `, el("span", { class: "badge" }, [typeLabel])]),
      el("td", {}, [String(t.page_count)]),
      el("td", {}, [
        el("a", { href: t.sample_url, target: "_blank", rel: "noopener" }, [t.sample_url])
      ]),
      el("td", {}, [t.contentSignalSummary || ""])
    ]);
    const detailChildren = [
      el("div", {}, [el("strong", {}, ["Sample title: "]), t.sample_title || "(untitled)"]),
      el("div", {}, [el("strong", {}, ["Page type: "]), typeLabel,
        (t.sample_spaMarkers || []).length ? ` — markers: ${t.sample_spaMarkers.join(", ")}` : ""
      ]),
      el("div", {}, [el("strong", {}, ["Audit roll-up: "]),
        `${t.totalViolations || 0} violation(s), ${t.totalIncomplete || 0} incomplete, ${t.totalPasses || 0} pass(es) across ${t.page_count} page(s)`
      ]),
      el("div", {}, [
        el("strong", {}, [`Pages in this template (${t.page_count}):`])
      ]),
      (() => {
        const ul = el("ul");
        const show = (t.pages || []).slice(0, 200);
        for (const p of show) {
          ul.appendChild(el("li", {}, [
            el("a", { href: p.url, target: "_blank", rel: "noopener" }, [p.url]),
            p.title ? ` — ${p.title}` : "",
            ` [${p.violations} viol · ${p.incomplete} incomp]`
          ]));
        }
        return ul;
      })(),
      renderRecommendedTestsDetail(t.recommendedTests)
    ];
    const comp = renderComponentsDetail(t.sample_components);
    if (comp) detailChildren.push(comp);
    const auditDetail = renderAuditDetail(t.sample_audit);
    if (auditDetail) detailChildren.push(auditDetail);
    const shot = renderScreenshot(t.sample_screenshot, `Sample screenshot — ${t.sample_url}`);
    if (shot) detailChildren.push(shot);

    const detail = el("tr", { class: "template-detail-row" }, [
      el("td", { colspan: "5" }, detailChildren)
    ]);
    row.addEventListener("click", () => row.classList.toggle("expanded"));
    tbody.appendChild(row);
    tbody.appendChild(detail);
  });
}

function renderSample(inventory) {
  const tbody = document.querySelector("#sample-table tbody");
  tbody.innerHTML = "";
  const sample = inventory.proposedSample || [];
  if (!sample.length) {
    tbody.appendChild(el("tr", {}, [
      el("td", { colspan: "5", class: "muted" }, ["No sample computed."])
    ]));
    return;
  }
  sample.forEach((s, i) => {
    tbody.appendChild(el("tr", {}, [
      el("td", {}, [String(i + 1)]),
      el("td", {}, [
        el("a", { href: s.url, target: "_blank", rel: "noopener" }, [s.url])
      ]),
      el("td", { class: "mono" }, [s.template_id || ""]),
      el("td", {}, [s.reason || ""]),
      el("td", {}, [String(s.testCount ?? 0)])
    ]));
  });
}

function renderPages(inventory) {
  const tbody = document.querySelector("#pages-table tbody");
  tbody.innerHTML = "";
  const pages = inventory.pages || [];
  const colspan = "14";
  if (!pages.length) {
    tbody.appendChild(el("tr", {}, [
      el("td", { colspan, class: "muted" }, ["No pages crawled."])
    ]));
    return;
  }
  pages.forEach(p => {
    if (p.error) {
      const row = el("tr", { class: "page-row" }, [
        el("td", {}, [
          el("a", { href: p.url, target: "_blank", rel: "noopener" }, [p.url])
        ]),
        el("td", { class: "muted" }, ["(error)"]),
        el("td", { class: "muted" }, ["—"]),
        el("td", {}, [String(p.depth ?? "")]),
        el("td", {}, [p.source || ""]),
        ...Array.from({ length: 9 }, () => el("td", { class: "muted" }, ["—"]))
      ]);
      const detail = el("tr", { class: "page-detail-row" }, [
        el("td", { colspan }, [
          el("div", {}, [el("strong", {}, ["Error: "]), p.error])
        ])
      ]);
      row.addEventListener("click", () => row.classList.toggle("expanded"));
      tbody.appendChild(row);
      tbody.appendChild(detail);
      return;
    }

    const c = p.counts || {};
    const f = p.flags || {};
    const violations = (p.audit?.violations || []).length;
    const incomplete = (p.audit?.incomplete || []).length;
    const typeLabel = p.pageType === "dynamic" ? "dynamic" : (p.pageType || "static");

    const row = el("tr", { class: "page-row" }, [
      el("td", {}, [
        el("a", { href: p.url, target: "_blank", rel: "noopener" }, [p.url])
      ]),
      el("td", { class: "mono" }, [p.template_id || ""]),
      el("td", {}, [el("span", { class: "badge" }, [typeLabel])]),
      el("td", {}, [String(p.depth ?? "")]),
      el("td", {}, [p.source || ""]),
      el("td", { class: violations > 0 ? "fail" : "" }, [String(violations)]),
      el("td", {}, [String(incomplete)]),
      el("td", {}, [String(c.forms ?? 0)]),
      el("td", {}, [String(c.dataTables ?? c.tables ?? 0)]),
      el("td", {}, [String(c.modals ?? 0)]),
      el("td", {}, [String(c.carousels ?? 0)]),
      el("td", {}, [String(c.pdfLinks ?? 0)]),
      boolCell(f.hasLogin),
      boolCell(!!p.screenshot?.id)
    ]);

    const detailChildren = [
      el("div", {}, [el("strong", {}, ["Title: "]), p.title || "(untitled)"]),
      el("div", {}, [el("strong", {}, ["HTML lang: "]), p.htmlLang || "(unset)"]),
      el("div", {}, [el("strong", {}, ["Page type: "]), typeLabel,
        (p.spaMarkers || []).length ? ` — ${p.spaMarkers.join(", ")}` : ""
      ]),
    ];
    if (p.finalUrl && p.finalUrl !== p.url) {
      detailChildren.push(el("div", {}, [
        el("strong", {}, ["Settled URL: "]), p.finalUrl,
        " ", el("span", { class: "muted" }, ["(client-side redirect from queued URL)"])
      ]));
    }
    if (p.visit_count && p.visit_count > 1) {
      const alt = (p.alt_discoveries || []).map(a => `${a.source || "?"}@d${a.depth ?? "?"}`).join(", ");
      detailChildren.push(el("div", {}, [
        el("strong", {}, [`Crawled ${p.visit_count}× — `]),
        `also reached via: ${alt || "unknown"}`
      ]));
    }
    detailChildren.push(
      el("div", {}, [
        el("strong", {}, ["Flags: "]),
        Object.entries(f).filter(([, v]) => v === true).map(([k]) => k).join(", ") || "(none)"
      ]),
      el("div", {}, [
        el("strong", {}, ["Counts: "]),
        Object.entries(c).filter(([, v]) => Number(v) > 0)
          .map(([k, v]) => `${k}=${v}`).join(", ") || "(none)"
      ]),
      renderRecommendedTestsDetail(p.recommendedTests)
    );
    const comp = renderComponentsDetail(p.components);
    if (comp) detailChildren.push(comp);
    const auditDetail = renderAuditDetail(p.audit);
    if (auditDetail) detailChildren.push(auditDetail);
    const shot = renderScreenshot(p.screenshot, "Full-page screenshot");
    if (shot) detailChildren.push(shot);

    const detail = el("tr", { class: "page-detail-row" }, [
      el("td", { colspan }, detailChildren)
    ]);

    row.addEventListener("click", () => row.classList.toggle("expanded"));
    tbody.appendChild(row);
    tbody.appendChild(detail);
  });
}

function wireDownloads() {
  const btnDocx = document.getElementById("btn-download-docx");
  const btnXlsx = document.getElementById("btn-download-xlsx");

  async function download(type, button) {
    const originalText = button.textContent;
    button.disabled = true;
    button.textContent = "Preparing…";
    try {
      const res = await send({ type, inventoryId });
      if (!res?.ok) {
        alert(res?.error || "Download failed.");
      }
    } catch (e) {
      alert(`Download failed: ${e?.message || e}`);
    } finally {
      button.disabled = false;
      button.textContent = originalText;
    }
  }

  const btnClusters = document.getElementById("btn-download-clusters");
  const btnAudit = document.getElementById("btn-download-audit");

  btnDocx?.addEventListener("click", () => download("DOWNLOAD_SCOPE_DOCX", btnDocx));
  btnXlsx?.addEventListener("click", () => download("DOWNLOAD_INVENTORY_XLSX", btnXlsx));
  btnClusters?.addEventListener("click", () => download("DOWNLOAD_CLUSTERS_XLSX", btnClusters));
  btnAudit?.addEventListener("click", () => download("DOWNLOAD_AUDIT_XLSX", btnAudit));
}

// ─────────────────────────────────────────────────────────────────────
// Tab bar — APG-pattern tablist. Click + arrow-key navigation.
// ─────────────────────────────────────────────────────────────────────
function wireTabs() {
  const tabs = Array.from(document.querySelectorAll('[role="tab"]'));
  if (!tabs.length) return;

  function activate(tab) {
    for (const t of tabs) {
      const selected = t === tab;
      t.setAttribute("aria-selected", selected ? "true" : "false");
      t.setAttribute("tabindex", selected ? "0" : "-1");
      t.classList.toggle("active", selected);
      const panel = document.getElementById(t.getAttribute("aria-controls"));
      if (panel) panel.hidden = !selected;
    }
  }

  tabs.forEach((tab, idx) => {
    tab.addEventListener("click", () => { activate(tab); tab.focus(); });
    tab.addEventListener("keydown", e => {
      let next = null;
      if (e.key === "ArrowRight") next = tabs[(idx + 1) % tabs.length];
      else if (e.key === "ArrowLeft") next = tabs[(idx - 1 + tabs.length) % tabs.length];
      else if (e.key === "Home") next = tabs[0];
      else if (e.key === "End") next = tabs[tabs.length - 1];
      if (next) { e.preventDefault(); activate(next); next.focus(); }
    });
  });
}

// ─────────────────────────────────────────────────────────────────────
// Findings tab — one row per violation-node instance across every crawled
// page. Columns: Rule · Impact · Target · Compliance · Standards · SC ·
// Code Snippet · Failure Summary · Help. Grouped by page URL.
// ─────────────────────────────────────────────────────────────────────

// Flatten the inventory into a sortable/filterable finding list. Each
// finding = one (page, rule, node) triple.
function collectFindings(inventory) {
  const findings = [];
  for (const p of inventory.pages || []) {
    if (p.error) continue;
    for (const v of (p.audit?.violations || [])) {
      const derived = deriveFromTags(v.tags || []);
      const nodes = v.nodes && v.nodes.length ? v.nodes : [{}];
      for (const n of nodes) {
        findings.push({
          url: p.url,
          ruleId: v.id || "",
          impact: (v.impact || "").toLowerCase(),
          description: v.description || v.help || "",
          help: v.help || "",
          helpUrl: v.helpUrl || "",
          target: (n.target || []).join(" ") || "",
          html: n.html || "",
          failureSummary: n.failureSummary || "",
          compliance: derived.compliance,
          standards: derived.standards,
          successCriteria: derived.successCriteria
        });
      }
    }
  }
  return findings;
}

const IMPACT_ORDER = { critical: 0, serious: 1, moderate: 2, minor: 3, "": 4 };

function renderFindings(inventory) {
  const host = document.getElementById("findings-list");
  const countEl = document.getElementById("findings-count");
  const searchInput = document.getElementById("findings-search");
  const impactInputs = Array.from(document.querySelectorAll(".impact-filter"));
  if (!host) return;

  const findings = collectFindings(inventory);

  function render() {
    const q = (searchInput?.value || "").toLowerCase().trim();
    const allowedImpacts = new Set(
      impactInputs.filter(i => i.checked).map(i => i.value)
    );

    const filtered = findings.filter(f => {
      if (!allowedImpacts.has(f.impact)) {
        // Unknown/unset impact shows only if ALL impact chips are on (treat as "everything").
        if (allowedImpacts.size !== impactInputs.length) return false;
      }
      if (!q) return true;
      return (
        f.ruleId.toLowerCase().includes(q) ||
        f.description.toLowerCase().includes(q) ||
        f.target.toLowerCase().includes(q) ||
        f.failureSummary.toLowerCase().includes(q) ||
        f.url.toLowerCase().includes(q) ||
        f.successCriteria.toLowerCase().includes(q)
      );
    });

    if (countEl) {
      countEl.textContent = filtered.length === findings.length
        ? `${findings.length} finding${findings.length === 1 ? "" : "s"}`
        : `${filtered.length} of ${findings.length} findings`;
    }

    // Group by URL.
    const byUrl = new Map();
    for (const f of filtered) {
      if (!byUrl.has(f.url)) byUrl.set(f.url, []);
      byUrl.get(f.url).push(f);
    }

    host.innerHTML = "";
    if (!filtered.length) {
      host.appendChild(el("p", { class: "muted" }, [
        findings.length === 0
          ? "No violations detected across the crawled pages."
          : "No findings match the current filters."
      ]));
      return;
    }

    for (const [url, group] of byUrl) {
      // Sort within a page by impact severity, then rule id.
      group.sort((a, b) => {
        const ia = IMPACT_ORDER[a.impact] ?? 5;
        const ib = IMPACT_ORDER[b.impact] ?? 5;
        if (ia !== ib) return ia - ib;
        return a.ruleId.localeCompare(b.ruleId);
      });

      const section = el("section", { class: "finding-group" });
      const header = el("h3", { class: "finding-group-head" }, [
        el("a", { href: url, target: "_blank", rel: "noopener" }, [url]),
        el("span", { class: "muted" }, [` — ${group.length} finding${group.length === 1 ? "" : "s"}`])
      ]);
      section.appendChild(header);

      const tbl = el("table", { class: "findings-table" });
      tbl.appendChild(el("thead", {}, [
        el("tr", {}, [
          el("th", {}, ["Impact"]),
          el("th", {}, ["Target"]),
          el("th", {}, ["Compliance"]),
          el("th", {}, ["Standards"]),
          el("th", {}, ["Success Criteria"]),
          el("th", {}, ["Code Snippet"]),
          el("th", {}, ["Failure Summary"]),
          el("th", {}, ["Help"])
        ])
      ]));
      const tb = el("tbody");
      for (const f of group) {
        const helpCell = el("td", {});
        if (f.helpUrl) {
          helpCell.appendChild(el("a", { href: f.helpUrl, target: "_blank", rel: "noopener" },
            [f.help || "Learn more"]));
        } else {
          helpCell.textContent = f.help || "";
        }
        tb.appendChild(el("tr", { class: `impact-${f.impact || "none"}` }, [
          el("td", {}, [el("span", { class: `impact-badge impact-${f.impact || "none"}` }, [f.impact || "—"])]),
          el("td", { class: "mono wrap-anywhere" }, [f.target || "—"]),
          el("td", {}, [f.compliance]),
          el("td", {}, [f.standards]),
          el("td", {}, [f.successCriteria]),
          el("td", {}, [el("pre", { class: "code-snippet" }, [f.html || "—"])]),
          el("td", {}, [f.failureSummary || "—"]),
          helpCell
        ]));
      }
      tbl.appendChild(tb);
      section.appendChild(tbl);
      host.appendChild(section);
    }
  }

  searchInput?.addEventListener("input", render);
  for (const i of impactInputs) i.addEventListener("change", render);
  render();
}

// ─────────────────────────────────────────────────────────────────────
// Screenshots tab — grid of every crawled page that has a screenshot.
// Reuses renderScreenshot() so each thumbnail lazy-loads via the shared
// IntersectionObserver (same path used inside the Templates tab).
// ─────────────────────────────────────────────────────────────────────
function renderScreenshotsTab(inventory) {
  const host = document.getElementById("screenshots-grid");
  const countEl = document.getElementById("screenshots-count");
  const searchInput = document.getElementById("screenshots-search");
  if (!host) return;

  const withShot = (inventory.pages || []).filter(p => !p.error && p.screenshot?.id);

  function render() {
    const q = (searchInput?.value || "").toLowerCase().trim();
    const filtered = q
      ? withShot.filter(p =>
          (p.url || "").toLowerCase().includes(q) ||
          (p.title || "").toLowerCase().includes(q)
        )
      : withShot;

    if (countEl) {
      countEl.textContent = filtered.length === withShot.length
        ? `${withShot.length} screenshot${withShot.length === 1 ? "" : "s"}`
        : `${filtered.length} of ${withShot.length} screenshots`;
    }

    host.innerHTML = "";
    if (!filtered.length) {
      host.appendChild(el("p", { class: "muted" }, [
        withShot.length === 0
          ? "No screenshots were captured during this crawl."
          : "No screenshots match the current search."
      ]));
      return;
    }

    for (const p of filtered) {
      const card = el("figure", { class: "screenshot-card" });
      card.appendChild(el("figcaption", { class: "screenshot-caption" }, [
        el("div", { class: "screenshot-title" }, [p.title || "(untitled)"]),
        el("a", {
          href: p.url, target: "_blank", rel: "noopener",
          class: "screenshot-url"
        }, [p.url])
      ]));
      const shot = renderScreenshot(p.screenshot, "");
      if (shot) {
        // renderScreenshot adds its own caption div; we don't need it here.
        const caption = shot.querySelector(".check-group-label");
        if (caption) caption.remove();
        card.appendChild(shot);
      }
      host.appendChild(card);
    }
  }

  searchInput?.addEventListener("input", render);
  render();
}

async function main() {
  if (!inventoryId) {
    document.body.innerHTML =
      '<main class="wrap"><h2>Missing inventory id</h2><p>Open this page via the extension popup (Inventory / Scope Mode).</p></main>';
    return;
  }
  const res = await send({ type: "GET_INVENTORY", inventoryId });
  if (!res?.ok || !res.inventory) {
    document.body.innerHTML =
      '<main class="wrap"><h2>Inventory unavailable</h2><p>The scope data has expired. Re-run the scope scan from the popup.</p></main>';
    return;
  }
  const inventory = res.inventory;
  renderMeta(inventory);
  renderStats(inventory);
  renderAuditStats(inventory);
  renderContentTypes(inventory);
  renderShellPages(inventory);
  renderTemplates(inventory);
  renderSample(inventory);
  renderPages(inventory);
  renderFindings(inventory);
  renderScreenshotsTab(inventory);
  wireTabs();
  wireDownloads();
}

function renderShellPages(inventory) {
  const section = document.getElementById("shell-section");
  const hint = document.getElementById("shell-hint");
  const list = document.getElementById("shell-list");
  if (!section || !hint || !list) return;
  const summary = inventory.shellSummary;
  if (!summary || !summary.count) { section.hidden = true; return; }
  section.hidden = false;
  hint.textContent = `${summary.count} URL${summary.count === 1 ? "" : "s"} returned the same DOM + text as the seed page (probable soft-404 / SPA shell). Excluded from the pages + templates tables below. ${summary.explanation || ""}`;
  list.innerHTML = "";
  for (const u of summary.sample_urls || []) {
    list.appendChild(el("li", {}, [
      el("a", { href: u, target: "_blank", rel: "noopener" }, [u])
    ]));
  }
  if (summary.count > (summary.sample_urls || []).length) {
    list.appendChild(el("li", { class: "muted" }, [
      `… and ${summary.count - (summary.sample_urls || []).length} more (see full inventory xlsx)`
    ]));
  }
}

main().catch(err => {
  console.error(err);
  document.body.innerHTML =
    `<main class="wrap"><h2>Render error</h2><pre>${escape(err?.stack || err?.message || err)}</pre></main>`;
});
