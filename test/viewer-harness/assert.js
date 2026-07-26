// Runs after report.js has rendered. Writes PASS/FAIL lines into a <pre> so
// `--dump-dom` can read them. Waits for the lazy loader to settle first: the
// IntersectionObserver fires off the main thread, and each hit does async
// storage/message work.

const results = [];
function check(name, cond, detail) {
  results.push(`${cond ? "PASS" : "FAIL"}  ${name}${detail ? "  — " + detail : ""}`);
}

async function settle() {
  // Force every thumbnail to load regardless of viewport position, so the run
  // is deterministic rather than dependent on the headless window height.
  for (const img of document.querySelectorAll("img[data-shot-id]")) {
    if (typeof loadScreenshot === "function") loadScreenshot(img);
  }
  for (let i = 0; i < 60; i++) {
    await new Promise(r => setTimeout(r, 50));
    const pending = [...document.querySelectorAll("img[data-shot-id]")]
      .filter(im => !["1", "error"].includes(im.getAttribute("data-loaded")));
    if (!pending.length) break;
  }
}

(async () => {
  // Let report.js's async IIFE finish first.
  for (let i = 0; i < 40 && !document.querySelector("#issues-table tbody tr"); i++) {
    await new Promise(r => setTimeout(r, 50));
  }
  await settle();

  // ── Bug A: the gallery section must exist AND become visible ──
  const section = document.getElementById("screenshots-section");
  const grid = document.getElementById("screenshots-grid");
  check("gallery section exists in DOM", !!section);
  check("gallery grid exists in DOM", !!grid);
  check("gallery section is revealed (hidden attr cleared)", section && !section.hidden,
        section ? `hidden=${section.hidden}` : "no section");
  check("gallery grid uses .screenshots-grid class (matches report.css)",
        grid && grid.classList.contains("screenshots-grid"),
        grid ? grid.className : "");

  // 3 of 4 synthetic pages carry a screenshot id; the 4th must not get a card.
  const cards = document.querySelectorAll("#screenshots-grid .screenshot-card");
  check("gallery rendered exactly 3 cards (page without screenshot skipped)",
        cards.length === 3, `got ${cards.length}`);
  const captions = [...document.querySelectorAll("#screenshots-grid .screenshot-title")]
    .map(n => n.textContent);
  check("no card for the screenshot-less page",
        !captions.some(c => /Legal/.test(c)), captions.join(" | "));

  // ── Screenshot column in Violations ──
  const ths = [...document.querySelectorAll("#issues-table thead th")].map(t => t.textContent.trim());
  check("Violations table has a Screenshot column header",
        ths.includes("Screenshot"), ths.join(" | "));
  const firstRow = document.querySelector("#issues-table tbody tr.issue-row");
  const tdCount = firstRow ? firstRow.children.length : 0;
  check("issue row td count matches th count",
        tdCount === ths.length, `td=${tdCount} th=${ths.length}`);
  const detailRow = document.querySelector("#issues-table tbody tr.issue-detail-row td");
  check("detail row colspan spans all columns",
        detailRow && Number(detailRow.getAttribute("colspan")) === ths.length,
        detailRow ? `colspan=${detailRow.getAttribute("colspan")}` : "none");
  check("element-shot cells rendered", document.querySelectorAll("td.element-shot-cell").length === 3,
        String(document.querySelectorAll("td.element-shot-cell").length));
  // The third issue has no elementShotId -> em-dash placeholder, not an <img>.
  const cells = [...document.querySelectorAll("td.element-shot-cell")];
  check("issue with no elementShotId renders placeholder, not an img",
        cells[2] && !cells[2].querySelector("img") && /—/.test(cells[2].textContent),
        cells[2] ? cells[2].innerHTML.slice(0, 60) : "missing");

  // ── Lazy loading: storage path, message fallback, and graceful failure ──
  const byId = id => document.querySelector(`img[data-shot-id="${id}"]`);
  const loaded = id => { const i = byId(id); return i && i.getAttribute("data-loaded"); };
  check("shot-page-1 loaded from chrome.storage.local", loaded("shot-page-1") === "1", String(loaded("shot-page-1")));
  check("shot-el-a loaded from chrome.storage.local",   loaded("shot-el-a") === "1",   String(loaded("shot-el-a")));
  check("shot-page-2 loaded via GET_SCREENSHOT fallback", loaded("shot-page-2") === "1", String(loaded("shot-page-2")));
  check("shot-el-b loaded via GET_SCREENSHOT fallback",   loaded("shot-el-b") === "1",   String(loaded("shot-el-b")));
  check("shot-page-3 (absent everywhere) degrades to error, no throw",
        loaded("shot-page-3") === "error", String(loaded("shot-page-3")));
  const missing = byId("shot-page-3");
  check("missing shot marked .screenshot-missing with alt text",
        missing && missing.classList.contains("screenshot-missing") && /unavailable/.test(missing.alt),
        missing ? `class=${missing.className} alt=${missing.alt}` : "none");

  // Real bytes actually decoded, not left on the 1x1 placeholder.
  const okImg = byId("shot-page-1");
  check("loaded image decoded with real dimensions (naturalWidth 480)",
        okImg && okImg.naturalWidth === 480, okImg ? `naturalWidth=${okImg.naturalWidth}` : "none");
  const elImg = byId("shot-el-a");
  check("element crop decoded at the new 400x300 minimum",
        elImg && elImg.naturalWidth === 400 && elImg.naturalHeight === 300,
        elImg ? `${elImg.naturalWidth}x${elImg.naturalHeight}` : "none");

  // Storage-first ordering: storage must be consulted before messaging.
  const calls = window.__HARNESS_CALLS;
  check("storage consulted for every thumbnail (storage-first)",
        calls.storageGet.length >= 5, `storage gets=${calls.storageGet.length}`);
  check("GET_SCREENSHOT only sent for shots missing from storage",
        !calls.sendMessage.includes("GET_SCREENSHOT:shot-page-1") &&
        !calls.sendMessage.includes("GET_SCREENSHOT:shot-el-a"),
        calls.sendMessage.filter(c => c.startsWith("GET_SCREENSHOT")).join(" | "));

  // ── Status pills must still work (the branch's own feature) ──
  check("status pills still rendered", document.querySelectorAll(".status-pill").length > 0,
        String(document.querySelectorAll(".status-pill").length));
  check("status tiles still rendered", !!document.querySelector("#pages-status-tiles .stat"));

  const failed = results.filter(r => r.startsWith("FAIL")).length;
  const pre = document.createElement("pre");
  pre.id = "harness-results";
  pre.textContent =
    "===HARNESS-START===\n" + results.join("\n") +
    `\n---\n${results.length - failed}/${results.length} passed\n===HARNESS-END===`;
  document.body.insertBefore(pre, document.body.firstChild);
})();
