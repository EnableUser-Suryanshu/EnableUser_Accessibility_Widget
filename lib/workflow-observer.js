// Workflow mode — in-page observer. Injected (chrome.scripting, file form)
// into ALL frames of a tab that has an active workflow session (both vendors
// arm every frame — iframe DOM changes are otherwise a coverage hole);
// re-injected by background on every completed navigation and after every
// workflow scan (the document that carried the previous observer is gone;
// iframes created after the last arming get observed — axe's re-arm-on-
// every-event lesson). Idempotent per document via window.__euWfObserver.
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

  // Subframe observers fingerprint and signal exactly like the top frame —
  // extension messaging works from any frame and sender.tab.id is the same
  // tab, so background re-scans the top document (axe's cross-frame protocol
  // descends into the iframes). But a subframe must NOT report its own
  // location.href as the page URL: only the top frame sends href/title;
  // background falls back to tab.url for subframe signals.
  const isTop = window === window.top;

  // Trigger mode (BrowserStack's two modes, digest III.4): "observer"
  // (default) = MutationObserver; "activity" = scan after user interaction
  // settles. Background injects window.__euWfMode BEFORE this file when the
  // operator enabled the wfScanOnActivity setting.
  const mode = window.__euWfMode === "activity" ? "activity" : "observer";

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
      const origin = isTop
        ? { href: location.href, title: document.title }
        : { fromSubframe: true };
      chrome.runtime.sendMessage({ type: kind, ...origin, ...extra });
    } catch { /* extension reloaded/mid-navigation — next injection re-arms */ }
  };

  let observer = null;          // mode "observer"
  let stopActivity = null;      // mode "activity"

  if (mode === "observer") {
    observer = new MutationObserver((mutations) => {
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
  } else {
    // Activity mode (BrowserStack's alternative, digest III.4 §2b): no
    // MutationObserver at all. User interactions — click/keydown/wheel on
    // the document, scroll on the window — are each debounced 300 ms; when
    // one settles, a further 300 ms settle timer runs, then a lightweight
    // DOM snapshot signature is compared against the previous one. Only a
    // CHANGED signature signals WF_MUTATED — scrolling a static page scans
    // nothing. The signature is body.innerHTML length + a rolling FNV hash
    // of the tag structure (pure twin: lib/workflow.js activitySignature) —
    // O(n) walk with O(1) memory per check, an algorithmic bound, not a
    // findings cap. We deliberately do NOT vendor diffDOM as BrowserStack
    // does: a hash comparison answers the only question asked ("did the
    // page change?").
    const DEBOUNCE_MS = 300, SETTLE_MS = 300;
    const snapshotSignature = () => {
      let h = 0x811c9dc5;
      const mix = (str) => { for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } };
      const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_ELEMENT);
      let first = true;
      for (let el = walker.currentNode; el; el = walker.nextNode()) {
        if (isOurs(el)) continue;
        mix((first ? "" : ">") + el.tagName);
        first = false;
      }
      return (h >>> 0).toString(36) + "." + (document.body.innerHTML || "").length;
    };
    let lastSig = snapshotSignature();       // per-document baseline
    let settleTimer = null;
    const debouncers = {};                   // one debounce per event type (BS's per-listener debounce)
    const checkChanged = () => {
      settleTimer = null;
      const sig = snapshotSignature();
      if (sig === lastSig) return;
      lastSig = sig;
      signal("WF_MUTATED");
    };
    const onActivity = (e) => {
      const t = e.type;
      if (debouncers[t]) clearTimeout(debouncers[t]);
      debouncers[t] = setTimeout(() => {
        delete debouncers[t];
        if (settleTimer) clearTimeout(settleTimer);
        settleTimer = setTimeout(checkChanged, SETTLE_MS);
      }, DEBOUNCE_MS);
    };
    document.addEventListener("click", onActivity, true);
    document.addEventListener("keydown", onActivity, true);
    document.addEventListener("wheel", onActivity, { capture: true, passive: true });
    window.addEventListener("scroll", onActivity, { passive: true });
    stopActivity = () => {
      document.removeEventListener("click", onActivity, true);
      document.removeEventListener("keydown", onActivity, true);
      document.removeEventListener("wheel", onActivity, { capture: true });
      window.removeEventListener("scroll", onActivity);
      for (const k of Object.keys(debouncers)) clearTimeout(debouncers[k]);
      if (settleTimer) clearTimeout(settleTimer);
    };
  }

  const onClick = (e) => {
    const el = e.target && e.target.closest ? (e.target.closest("a, button, [role=button], input, [onclick]") || e.target) : e.target;
    if (!el || isOurs(el)) return;
    // BrowserStack's step object carries coordinates/value/href alongside the
    // element identity — enough context to replay or explain the step later.
    const info = {
      tag: (el.tagName || "").toLowerCase(),
      text: String(el.textContent || el.value || "").trim().replace(/\s+/g, " ").slice(0, 80),
      selector: pathOf(el),
      coordinates: { x: e.clientX, y: e.clientY }
    };
    // Form-control value (truncated 80) — but a password's value must never
    // enter a stored session, report, or workbook.
    const tagUp = el.tagName || "";
    if ((tagUp === "INPUT" || tagUp === "TEXTAREA" || tagUp === "SELECT") && el.type !== "password") {
      const v = String(el.value || "").slice(0, 80);
      if (v) info.value = v;
    }
    const anchor = el.closest ? el.closest("a[href]") : null;
    if (anchor && anchor.href) info.href = String(anchor.href);
    signal("WF_CLICK", { info });
  };
  document.addEventListener("click", onClick, true);

  // Keep-alive port (top frame only — one per tab is enough): while the
  // session records, the background worker must not be evicted or its
  // pending debounce timers die with it. A long-lived port resets the MV3
  // idle timer (BrowserStack's 250 s pattern); when Chrome drops it (worker
  // cycled), reconnecting immediately revives the worker. stop() ends the
  // loop; a connect() throw means the extension itself is gone — stop too.
  let keepalivePort = null, keepaliveStopped = false;
  const connectKeepalive = () => {
    if (keepaliveStopped) return;
    try {
      keepalivePort = chrome.runtime.connect({ name: "eu-wf-keepalive" });
      keepalivePort.onDisconnect.addListener(() => {
        keepalivePort = null;
        if (!keepaliveStopped) setTimeout(connectKeepalive, 1_000);
      });
    } catch { keepalivePort = null; }
  };
  if (isTop) connectKeepalive();

  window.__euWfObserver = {
    stop() {
      try { observer && observer.disconnect(); } catch {}
      try { stopActivity && stopActivity(); } catch {}
      document.removeEventListener("click", onClick, true);
      keepaliveStopped = true;
      try { keepalivePort && keepalivePort.disconnect(); } catch {}
      keepalivePort = null;
      window.__euWfObserver = null;
    }
  };

  window.addEventListener("beforeunload", () => {
    try { window.__euWfObserver && window.__euWfObserver.stop(); } catch {}
  });
})();
