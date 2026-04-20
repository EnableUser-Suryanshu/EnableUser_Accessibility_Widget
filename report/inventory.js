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

  host.appendChild(stat("Pages Scanned", ok));
  if (errs > 0) host.appendChild(stat("Unreachable", errs, "fail"));
  host.appendChild(stat("Templates", templates));
  host.appendChild(stat("Content Types", contentTypesDetected));
  host.appendChild(stat("Proposed Sample", samplePages));
  host.appendChild(stat("Manual Tests", testsTotal));
  host.appendChild(stat("Max URLs", inventory.meta?.maxUrls ?? "—"));
  host.appendChild(stat("Crawl Depth", inventory.meta?.crawlDepth ?? "—"));
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
    const row = el("tr", { class: "template-row" }, [
      el("td", { class: "mono" }, [t.template_id || ""]),
      el("td", {}, [t.url_cluster || ""]),
      el("td", {}, [String(t.page_count)]),
      el("td", {}, [
        el("a", { href: t.sample_url, target: "_blank", rel: "noopener" }, [t.sample_url])
      ]),
      el("td", {}, [t.contentSignalSummary || ""])
    ]);
    const detail = el("tr", { class: "template-detail-row" }, [
      el("td", { colspan: "5" }, [
        el("div", {}, [el("strong", {}, ["Sample title: "]), t.sample_title || "(untitled)"]),
        el("div", {}, [
          el("strong", {}, [`Pages in this template (${t.page_count}):`])
        ]),
        (() => {
          const ul = el("ul");
          const show = (t.pages || []).slice(0, 200);
          for (const p of show) {
            ul.appendChild(el("li", {}, [
              el("a", { href: p.url, target: "_blank", rel: "noopener" }, [p.url]),
              p.title ? ` — ${p.title}` : ""
            ]));
          }
          return ul;
        })(),
        renderRecommendedTestsDetail(t.recommendedTests)
      ])
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
  if (!pages.length) {
    tbody.appendChild(el("tr", {}, [
      el("td", { colspan: "13", class: "muted" }, ["No pages crawled."])
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
        el("td", {}, [p.url_cluster || ""]),
        el("td", {}, [String(p.depth ?? "")]),
        el("td", {}, [p.source || ""]),
        ...Array.from({ length: 8 }, () => el("td", { class: "muted" }, ["—"]))
      ]);
      const detail = el("tr", { class: "page-detail-row" }, [
        el("td", { colspan: "13" }, [
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
    const row = el("tr", { class: "page-row" }, [
      el("td", {}, [
        el("a", { href: p.url, target: "_blank", rel: "noopener" }, [p.url])
      ]),
      el("td", { class: "mono" }, [p.template_id || ""]),
      el("td", {}, [p.url_cluster || ""]),
      el("td", {}, [String(p.depth ?? "")]),
      el("td", {}, [p.source || ""]),
      el("td", {}, [String(c.forms ?? 0)]),
      el("td", {}, [String(c.dataTables ?? c.tables ?? 0)]),
      el("td", {}, [String((c.videos ?? 0) + (c.youtube ?? 0) + (c.vimeo ?? 0))]),
      el("td", {}, [String(c.iframes ?? 0)]),
      el("td", {}, [String(c.modals ?? 0)]),
      el("td", {}, [String(c.carousels ?? 0)]),
      el("td", {}, [String(c.pdfLinks ?? 0)]),
      boolCell(f.hasLogin)
    ]);

    const detail = el("tr", { class: "page-detail-row" }, [
      el("td", { colspan: "13" }, [
        el("div", {}, [el("strong", {}, ["Title: "]), p.title || "(untitled)"]),
        el("div", {}, [el("strong", {}, ["HTML lang: "]), p.htmlLang || "(unset)"]),
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
      ])
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
