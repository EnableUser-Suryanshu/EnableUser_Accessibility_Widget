// On-page issue overlay — annotates the live page with its CONFIRMED violations,
// each showing the offending markup and the fix axe recommends.
//
// Only violations are rendered. Incomplete / needs-review results are
// deliberately excluded: they are, by definition, findings the engine could not
// prove, and drawing them on the page as though they were defects is exactly the
// over-claiming the report format is careful to avoid. A developer looking at a
// red box wants to know it is really broken.
//
// Runs in the ISOLATED world (see background.js), so page scripts cannot see or
// clash with any of this, and the page's own CSS cannot restyle it. Everything is
// inline-styled for the same reason — a page stylesheet must not be able to hide
// the overlay.
//
// Nothing here mutates page content. Markers are positioned siblings inside a
// fixed root on <html>, never wrappers around the target, so no layout shifts and
// no risk of breaking the page being audited. clear() removes every trace.
(function () {
  const ROOT_ID = "__eu_issue_overlay__";
  const Z = "2147483000"; // just under the element-highlight box used by screenshots

  const IMPACT = {
    critical: { fill: "#b91c1c", soft: "#fee2e2" },
    serious:  { fill: "#c2410c", soft: "#ffedd5" },
    moderate: { fill: "#a16207", soft: "#fef3c7" },
    minor:    { fill: "#475569", soft: "#f1f5f9" }
  };
  const impactOf = (s) => IMPACT[s] || IMPACT.minor;

  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, c =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  }

  // axe's failureSummary is a multi-line string whose first line is a heading
  // ("Fix any of the following:" / "Fix all of the following:") followed by the
  // individual remediations. Separate the two — rendering the heading as a bullet
  // alongside the fixes reads as though "Fix any of the following:" were itself
  // something to do, and loses the any/all distinction, which matters: "any"
  // means one fix suffices, "all" means every line is required.
  //
  // A summary can contain more than one such block (axe joins them), so headings
  // are kept in order with the items that follow them.
  function fixBlocks(node) {
    const raw = (node.failureSummary || "").trim();
    if (!raw) return [];
    const blocks = [];
    for (const line of raw.split("\n").map(l => l.trim()).filter(Boolean)) {
      if (/:$/.test(line)) blocks.push({ heading: line, items: [] });
      else if (blocks.length) blocks[blocks.length - 1].items.push(line);
      else blocks.push({ heading: "", items: [line] });
    }
    return blocks;
  }

  function resolve(node) {
    // Frame-aware targets (length > 1) address an element inside a nested frame,
    // which cannot be queried from the top document — those get a panel entry
    // with no on-page marker rather than being silently dropped.
    const t = Array.isArray(node.target) ? node.target : [];
    if (t.length !== 1 || typeof t[0] !== "string") return null;
    try { return document.querySelector(t[0]); } catch { return null; }
  }

  function clear() {
    const old = document.getElementById(ROOT_ID);
    if (old && old.remove) old.remove();
    window.removeEventListener("scroll", reposition, true);
    window.removeEventListener("resize", reposition);
    state.items = [];
    state.root = null;
  }

  const state = { items: [], panelOpen: true, root: null };

  // Markers live inside a position:fixed root, so their offsets are VIEWPORT
  // coordinates — which is exactly what getBoundingClientRect returns. No
  // scroll offset is added; that is what made the earlier absolute-root version
  // wrong on any page with a positioned or transformed body. The trade is that
  // every marker must be repositioned on scroll, hence the scroll listener.
  function reposition() {
    if (!state.root) return;
    // Where the root actually sits in the viewport. Should be 0,0, but a
    // transform or offset on an ancestor moves it — measuring instead of assuming
    // is what keeps markers on their elements regardless.
    const origin = state.root.getBoundingClientRect();
    for (const it of state.items) {
      if (!it.el || !it.box) continue;
      const r = it.el.getBoundingClientRect();
      if (!r.width && !r.height) { it.box.style.display = "none"; continue; }
      // Cull markers well outside the viewport so a 500-issue page isn't
      // laying out hundreds of off-screen boxes on every scroll event.
      if (r.bottom < -200 || r.top > window.innerHeight + 200) {
        it.box.style.display = "none";
        continue;
      }
      it.box.style.display = "";
      it.box.style.left = (r.left - origin.left - 2) + "px";
      it.box.style.top = (r.top - origin.top - 2) + "px";
      it.box.style.width = (r.width + 4) + "px";
      it.box.style.height = (r.height + 4) + "px";
    }
  }

  function flash(el) {
    try {
      el.scrollIntoView({ block: "center", inline: "center", behavior: "smooth" });
    } catch { try { el.scrollIntoView(); } catch {} }
  }

  function render(violations) {
    clear();
    const rules = Array.isArray(violations) ? violations : [];

    const root = document.createElement("div");
    root.id = ROOT_ID;
    // Markers are offset relative to this root and computed from viewport rects.
    //
    // The original version made the root position:absolute on <body>, which
    // resolves against the nearest positioned ancestor — so position:relative, a
    // transform, or a margin on body (all common) offset every marker away from
    // the element it pointed at, and un-pinned the panel.
    //
    // Fixed alone is NOT enough either: a transformed element becomes the containing
    // block for its fixed descendants too, so a fixed root inside a transformed
    // <body> is still offset by body's origin. Verified — the harness measured
    // markers 65px out (a 40px translate plus a 25px margin).
    //
    // Two defences, because either alone can be defeated:
    //  1. Append to <html>, not <body>, so a transform or offset on body is not
    //     an ancestor of the overlay at all.
    //  2. reposition() measures the root's OWN viewport rect and subtracts it,
    //     so wherever the root actually lands, marker offsets are computed
    //     relative to it. That self-corrects for anything an ancestor does,
    //     including a transform on <html> itself.
    root.style.cssText = "all:initial;position:fixed;top:0;left:0;width:0;height:0;z-index:" + Z + ";";
    (document.documentElement || document.body).appendChild(root);
    state.root = root;

    // Flatten to one entry per violating node, keeping its rule context.
    const entries = [];
    for (const r of rules) {
      for (const n of (r.nodes || [])) {
        entries.push({ rule: r, node: n, impact: n.impact || r.impact || "minor" });
      }
    }
    // Worst first, so the panel opens on what matters.
    const order = { critical: 0, serious: 1, moderate: 2, minor: 3 };
    entries.sort((a, b) => (order[a.impact] ?? 9) - (order[b.impact] ?? 9));

    let unresolved = 0;
    entries.forEach((entry, i) => {
      const num = i + 1;
      const el = resolve(entry.node);
      if (!el) { unresolved++; entry.el = null; state.items.push(entry); return; }
      const col = impactOf(entry.impact);

      const box = document.createElement("div");
      box.style.cssText =
        "position:absolute;box-sizing:border-box;pointer-events:none;" +
        `border:2px solid ${col.fill};background:${col.fill}14;z-index:${Z};`;

      const badge = document.createElement("div");
      badge.textContent = String(num);
      badge.style.cssText =
        "all:initial;position:absolute;top:-11px;left:-2px;min-width:18px;height:18px;" +
        `background:${col.fill};color:#fff;font:700 11px/18px ui-sans-serif,system-ui,sans-serif;` +
        "text-align:center;border-radius:9px;padding:0 5px;box-sizing:border-box;" +
        "pointer-events:auto;cursor:pointer;";
      badge.title = `${entry.rule.ruleId} — ${entry.impact}. Click to open in the panel.`;
      badge.addEventListener("click", (ev) => {
        ev.stopPropagation();
        const row = document.getElementById(`${ROOT_ID}_row_${num}`);
        if (row) {
          state.panelOpen = true;
          syncPanel();
          row.scrollIntoView({ block: "center" });
          row.style.outline = `2px solid ${col.fill}`;
          setTimeout(() => { row.style.outline = ""; }, 1600);
        }
      });
      box.appendChild(badge);
      root.appendChild(box);

      entry.el = el;
      entry.box = box;
      entry.num = num;
      state.items.push(entry);
    });

    // Row ids are keyed on position in the flattened list, NOT on the visible
    // badge number. Unmarkable entries (nested-frame targets, selectors that no
    // longer match) have no badge, and keying on `num || 0` gave every one of them
    // id `..._row_0` — duplicate element ids, which is invalid and something axe
    // itself flags. Ironic in an accessibility tool.
    state.items.forEach((entry, i) => { entry.rowKey = i + 1; });

    // ── Panel ──
    const panel = document.createElement("div");
    panel.id = ROOT_ID + "_panel";
    panel.style.cssText =
      "all:initial;position:fixed;right:16px;bottom:16px;width:420px;max-height:70vh;" +
      "background:#fff;color:#0f172a;border:1px solid #cbd5e1;border-radius:10px;" +
      "box-shadow:0 10px 30px rgba(2,6,23,.28);font:13px/1.5 ui-sans-serif,system-ui,sans-serif;" +
      `display:flex;flex-direction:column;overflow:hidden;z-index:${Z};`;

    const counts = entries.reduce((a, e) => (a[e.impact] = (a[e.impact] || 0) + 1, a), {});
    const summary = ["critical", "serious", "moderate", "minor"]
      .filter(k => counts[k]).map(k => `${counts[k]} ${k}`).join(" · ");

    const head = document.createElement("div");
    head.style.cssText =
      "all:initial;display:block;padding:10px 12px;background:#0f172a;color:#fff;" +
      "font:600 13px/1.4 ui-sans-serif,system-ui,sans-serif;flex:0 0 auto;";
    head.innerHTML =
      `<div>EnableUser — ${entries.length} confirmed issue${entries.length === 1 ? "" : "s"}</div>` +
      `<div style="font-weight:400;font-size:11px;opacity:.85;margin-top:2px">${esc(summary || "none")}` +
      (unresolved ? ` · ${unresolved} inside nested frames (not marked on page)` : "") +
      `</div>`;

    const btnRow = document.createElement("div");
    btnRow.style.cssText = "all:initial;display:flex;gap:6px;margin-top:8px;";
    const mkBtn = (label, onClick) => {
      const b = document.createElement("button");
      b.textContent = label;
      b.style.cssText =
        "all:initial;font:600 11px/1 ui-sans-serif,system-ui,sans-serif;padding:6px 9px;" +
        "background:#1e293b;color:#fff;border:1px solid #475569;border-radius:5px;cursor:pointer;";
      b.addEventListener("click", onClick);
      return b;
    };
    btnRow.appendChild(mkBtn("Hide list", () => { state.panelOpen = false; syncPanel(); }));
    btnRow.appendChild(mkBtn("Remove overlay", clear));
    head.appendChild(btnRow);
    panel.appendChild(head);

    const list = document.createElement("div");
    list.id = ROOT_ID + "_list";
    list.style.cssText = "all:initial;display:block;overflow-y:auto;padding:0;flex:1 1 auto;background:#fff;";

    for (const entry of state.items) {
      const col = impactOf(entry.impact);
      const row = document.createElement("div");
      // rowKey, not num — see the note where rowKey is assigned. For a marked
      // entry the two coincide (every entry is pushed to state.items in `entries`
      // order, so position === badge number), which is why the badge click
      // handler's lookup by num still resolves.
      row.id = `${ROOT_ID}_row_${entry.rowKey}`;
      row.style.cssText =
        "all:initial;display:block;padding:10px 12px;border-bottom:1px solid #e2e8f0;" +
        "font:13px/1.5 ui-sans-serif,system-ui,sans-serif;color:#0f172a;" +
        (entry.el ? "cursor:pointer;" : "");

      const wcag = (entry.rule.tags || []).filter(t => /^wcag\d/.test(t)).join(" ");
      const blocks = fixBlocks(entry.node);
      const fixHtml = blocks.map(b =>
        (b.heading ? `<div style="margin-top:4px;color:#475569">${esc(b.heading)}</div>` : "") +
        (b.items.length
          ? `<ul style="margin:3px 0 0;padding-left:18px;color:#334155">${b.items.map(f => `<li>${esc(f)}</li>`).join("")}</ul>`
          : "")
      ).join("");

      row.innerHTML =
        `<div style="display:flex;gap:8px;align-items:baseline">` +
          (entry.num
            ? `<span style="flex:0 0 auto;min-width:18px;height:18px;background:${col.fill};color:#fff;border-radius:9px;font:700 11px/18px ui-sans-serif;text-align:center">${entry.num}</span>`
            : `<span style="flex:0 0 auto;color:#94a3b8;font-size:11px">frame</span>`) +
          `<span style="font-weight:600">${esc(entry.rule.ruleId)}</span>` +
          `<span style="font-size:11px;padding:1px 6px;border-radius:9px;background:${col.soft};color:${col.fill};font-weight:600;text-transform:uppercase">${esc(entry.impact)}</span>` +
        `</div>` +
        `<div style="margin-top:4px;color:#334155">${esc(entry.rule.help || entry.rule.description)}</div>` +
        (wcag ? `<div style="margin-top:3px;font-size:11px;color:#64748b">${esc(wcag)}</div>` : "") +
        (fixHtml
          ? `<div style="margin-top:7px"><div style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.03em">How to fix</div>${fixHtml}</div>`
          : "") +
        `<div style="margin-top:7px"><div style="font-size:11px;font-weight:700;color:#475569;text-transform:uppercase;letter-spacing:.03em">Code</div>` +
        `<pre style="margin:4px 0 0;padding:7px 8px;background:#0f172a;color:#e2e8f0;border-radius:5px;overflow-x:auto;font:11px/1.5 ui-monospace,SFMono-Regular,Menlo,monospace;white-space:pre-wrap;word-break:break-word">${esc(entry.node.html)}</pre></div>` +
        `<div style="margin-top:5px;font-size:11px;color:#64748b;word-break:break-all">${esc(entry.node.targetJoined || (entry.node.target || []).join(" "))}</div>` +
        (entry.rule.helpUrl
          ? `<div style="margin-top:5px"><a href="${esc(entry.rule.helpUrl)}" target="_blank" rel="noopener" style="color:#1d4ed8;font-size:11px">axe rule reference →</a></div>`
          : "");

      if (entry.el) row.addEventListener("click", () => flash(entry.el));
      list.appendChild(row);
    }

    panel.appendChild(list);
    root.appendChild(panel);

    function syncPanel() {
      list.style.display = state.panelOpen ? "block" : "none";
      const hideBtn = btnRow.firstChild;
      if (hideBtn) hideBtn.textContent = state.panelOpen ? "Hide list" : "Show list";
    }
    state.syncPanel = syncPanel;
    syncPanel();

    reposition();
    window.addEventListener("scroll", reposition, true);
    window.addEventListener("resize", reposition);

    return { marked: entries.length - unresolved, unresolved, total: entries.length };
  }

  function syncPanel() { if (state.syncPanel) state.syncPanel(); }

  window.EU_IssueOverlay = { render, clear, isActive: () => !!document.getElementById(ROOT_ID) };
})();
