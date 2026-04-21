// Renderer for report/inventory.html
// Fetches the inventory built by background.js (SCAN_INVENTORY) and populates
// stats / content-type / templates / sample / pages tables. Wires up the two
// download buttons that produce the scope.docx + inventory.xlsx deliverables.

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

function renderScreenshot(shot, caption) {
  if (!shot?.dataUrl) return null;
  const wrap = el("div", { class: "screenshot-wrap" });
  wrap.appendChild(el("div", { class: "check-group-label" }, [caption || "Full-page screenshot"]));
  const img = el("img", { class: "screenshot-thumb", src: shot.dataUrl, alt: "full-page screenshot" });
  img.addEventListener("click", () => img.classList.toggle("expanded"));
  wrap.appendChild(img);
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
    const row = el("tr", { class: "template-row" }, [
      el("td", { class: "mono" }, [t.template_id || ""]),
      el("td", {}, [`${t.url_cluster || ""}  `, el("span", { class: "badge" }, [typeLabel])]),
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
      boolCell(!!p.screenshot?.dataUrl)
    ]);

    const detailChildren = [
      el("div", {}, [el("strong", {}, ["Title: "]), p.title || "(untitled)"]),
      el("div", {}, [el("strong", {}, ["HTML lang: "]), p.htmlLang || "(unset)"]),
      el("div", {}, [el("strong", {}, ["Page type: "]), typeLabel,
        (p.spaMarkers || []).length ? ` — ${p.spaMarkers.join(", ")}` : ""
      ]),
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
    ];
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

  btnDocx?.addEventListener("click", () => download("DOWNLOAD_SCOPE_DOCX", btnDocx));
  btnXlsx?.addEventListener("click", () => download("DOWNLOAD_INVENTORY_XLSX", btnXlsx));
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
  renderTemplates(inventory);
  renderSample(inventory);
  renderPages(inventory);
  wireDownloads();
}

main().catch(err => {
  console.error(err);
  document.body.innerHTML =
    `<main class="wrap"><h2>Render error</h2><pre>${escape(err?.stack || err?.message || err)}</pre></main>`;
});
