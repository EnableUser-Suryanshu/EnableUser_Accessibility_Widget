// Workflow mode — in-page observer. Injected (chrome.scripting, file form)
// into the top frame of a tab that has an active workflow session; re-injected
// by background on every completed navigation (the document that carried the
// previous observer is gone). Idempotent per document via window.__euWfObserver.
//
// Design per the mechanism digest:
// - MutationObserver on document.body with BrowserStack's config: childList +
//   subtree + attributes LIMITED to class (attributeFilter) — the class-only
//   filter is what keeps React/Vue re-render churn from firing constant
//   rescans.
// - Self-mutation guard: our own overlay elements (ids starting "__EU_")
//   never count, so highlighting/annotation can't trigger a rescan loop.
// - Hierarchical mutation fingerprints (BrowserStack layer-1 dedup): a
//   mutation whose fingerprint has been seen before is noise; only a batch
//   containing at least one NEW fingerprint reports upstream. Capped FIFO.
// - The observer only SIGNALS (WF_MUTATED with href); all pacing (suppressing
//   debounce + in-flight lock) lives in the background, mirroring axe's
//   split. A local 300 ms throttle just keeps message traffic sane.
// - Clicks are captured (capture phase) as timeline context — WF_CLICK with
//   tag/text/rough selector. They do not trigger scans; the mutations they
//   cause do.

(() => {
  if (window.__euWfObserver) return;      // already armed for this document
  if (!document.body) return;             // injected too early; background retries

  const MAX_FINGERPRINTS = 5000;
  const seen = new Set();
  const seenOrder = [];
  const remember = (fp) => {
    if (seen.has(fp)) return false;
    seen.add(fp);
    seenOrder.push(fp);
    if (seenOrder.length > MAX_FINGERPRINTS) seen.delete(seenOrder.shift());
    return true;
  };

  const isOurs = (node) => {
    let el = node && node.nodeType === 1 ? node : node && node.parentElement;
    for (let hops = 0; el && hops < 6; hops++, el = el.parentElement) {
      if (el.id && el.id.startsWith("__EU_")) return true;
    }
    return false;
  };

  const hash = (s) => {
    let h = 0x811c9dc5;
    for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
    return (h >>> 0).toString(36);
  };

  const pathOf = (el) => {
    const parts = [];
    let cur = el && el.nodeType === 1 ? el : el && el.parentElement;
    for (let hops = 0; cur && cur !== document.documentElement && hops < 8; hops++, cur = cur.parentElement) {
      let p = cur.tagName.toLowerCase();
      if (cur.id) { parts.unshift(p + "#" + cur.id); break; }
      const cls = typeof cur.className === "string" ? cur.className.trim().split(/\s+/).slice(0, 2).join(".") : "";
      parts.unshift(cls ? p + "." + cls : p);
    }
    return parts.join(">");
  };

  const fingerprint = (m) => {
    let spec = m.type;
    if (m.type === "attributes") {
      spec += ":attr:" + m.attributeName + ":" + hash(String((m.target && m.target.getAttribute && m.target.getAttribute(m.attributeName)) || ""));
    } else if (m.type === "characterData") {
      spec += ":text:" + hash(String(m.target.nodeValue || "").slice(0, 500));
    } else {
      const sig = (list, tag) => Array.from(list).map(n =>
        tag + ":" + (n.nodeType === 1 ? n.tagName : "TEXT:" + hash(String(n.nodeValue || "").slice(0, 200)))
      ).join(",");
      spec += ":" + sig(m.addedNodes, "add") + "|" + sig(m.removedNodes, "rem");
    }
    return hash(spec + "@" + pathOf(m.target));
  };

  let lastSignal = 0;
  const SIGNAL_THROTTLE_MS = 300;
  const signal = (kind, extra) => {
    try {
      chrome.runtime.sendMessage({ type: kind, href: location.href, title: document.title, ...extra });
    } catch { /* extension reloaded/mid-navigation — next injection re-arms */ }
  };

  const observer = new MutationObserver((mutations) => {
    let fresh = false;
    for (const m of mutations) {
      if (isOurs(m.target)) continue;
      let selfOnly = m.type === "childList";
      if (m.type === "childList") {
        for (const n of [...m.addedNodes, ...m.removedNodes]) {
          if (!isOurs(n)) { selfOnly = false; break; }
        }
        if (selfOnly && (m.addedNodes.length || m.removedNodes.length)) continue;
      }
      if (remember(fingerprint(m))) fresh = true;
    }
    if (!fresh) return;
    const now = Date.now();
    if (now - lastSignal < SIGNAL_THROTTLE_MS) return;   // suppress; background debounce absorbs the burst anyway
    lastSignal = now;
    signal("WF_MUTATED");
  });

  observer.observe(document.body, {
    childList: true,
    subtree: true,
    attributes: true,
    attributeFilter: ["class"],
    attributeOldValue: true
  });

  const onClick = (e) => {
    const el = e.target && e.target.closest ? (e.target.closest("a, button, [role=button], input, [onclick]") || e.target) : e.target;
    if (!el || isOurs(el)) return;
    signal("WF_CLICK", {
      info: {
        tag: (el.tagName || "").toLowerCase(),
        text: String(el.textContent || el.value || "").trim().replace(/\s+/g, " ").slice(0, 80),
        selector: pathOf(el)
      }
    });
  };
  document.addEventListener("click", onClick, true);

  window.__euWfObserver = {
    stop() {
      try { observer.disconnect(); } catch {}
      document.removeEventListener("click", onClick, true);
      window.__euWfObserver = null;
    }
  };

  window.addEventListener("beforeunload", () => {
    try { window.__euWfObserver && window.__euWfObserver.stop(); } catch {}
  });
})();
