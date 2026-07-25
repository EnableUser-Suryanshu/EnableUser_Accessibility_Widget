// v0.4.4 — internal broken-link (404) detector.
//
// Three detection layers, run from the extension service worker with the
// user's cookies (credentials: "include"), so results match what a real
// visitor sees:
//
//   1. HARD errors — every internal link target discovered during the crawl
//      is status-checked (HEAD, falling back to GET where HEAD is refused).
//      404/410 → hard-404; 5xx → server-error; other 4xx → client-error.
//
//   2. SOFT 404s — before checking, we probe two deliberately-nonexistent
//      URLs on the site to fingerprint its real "not found" behaviour:
//        • returns 404/410       → statuses are trustworthy (fast path)
//        • redirects to home     → redirect-to-home targets are dead links
//        • returns 200 + body    → the site serves soft 404s; we capture the
//          not-found page's text signature (word shingles) and compare every
//          200-status target's body against it (Jaccard similarity).
//      Independently, a title/H1 heuristic catches "404 — Page not found"
//      pages that don't match the probe signature.
//
//   3. REDIRECT-TO-HOME — a link that 30x-redirects to the homepage is the
//      classic silently-deleted page. Flagged even when the final status
//      is 200.
//
// Every finding carries its sources: which crawled pages contained the link,
// and the anchor text used — so the operator can go fix the actual <a> tags.

const SOFT404_TITLE_RX = /(^|\b)(404|page not found|not found|page unavailable|page (does ?n['o]?t|no longer) exist|no longer available|nothing (was )?found|page missing|content (not|un)available|oops)((\b|$))/i;

// Similarity threshold for the soft-404 body match. Not-found pages are
// template-rendered, so genuine matches score very high; 0.80 keeps
// coincidental shared-chrome (header/footer) matches out.
const SOFT404_SIMILARITY = 0.8;

const BODY_PREFIX_BYTES = 60_000;

function normalizeText(html) {
  return String(html || "")
    .replace(/<script[\s\S]*?<\/script>/gi, " ")
    .replace(/<style[\s\S]*?<\/style>/gi, " ")
    .replace(/<[^>]+>/g, " ")
    .replace(/&[a-z#0-9]+;/gi, " ")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

function extractTitle(html) {
  const t = /<title[^>]*>([\s\S]{0,300}?)<\/title>/i.exec(html || "");
  const h1 = /<h1[^>]*>([\s\S]{0,300}?)<\/h1>/i.exec(html || "");
  const clean = (s) => normalizeText(s || "");
  return { title: clean(t && t[1]), h1: clean(h1 && h1[1]) };
}

function shingles(text, size = 5) {
  const words = text.split(" ").filter(Boolean);
  const out = new Set();
  for (let i = 0; i + size <= words.length; i++) {
    out.add(words.slice(i, i + size).join(" "));
  }
  // Very short pages (< size words) still get one shingle so comparison works.
  if (out.size === 0 && words.length) out.add(words.join(" "));
  return out;
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const s of small) if (large.has(s)) inter++;
  return inter / (a.size + b.size - inter);
}

function isHomepage(url, origin) {
  try {
    const u = new URL(url);
    if (u.origin !== origin) return false;
    const p = u.pathname.replace(/\/+$/, "");
    return p === "" || /^\/(index\.(html?|php|aspx?))?$/i.test(u.pathname);
  } catch { return false; }
}

// Read at most maxBytes of a response body, then cancel the stream so we
// don't download multi-MB pages just to fingerprint them.
async function readBodyPrefix(res, maxBytes = BODY_PREFIX_BYTES) {
  if (!res.body) {
    const t = await res.text().catch(() => "");
    return t.slice(0, maxBytes);
  }
  const reader = res.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: false });
  let out = "";
  try {
    while (out.length < maxBytes) {
      const { done, value } = await reader.read();
      if (done) break;
      out += decoder.decode(value, { stream: true });
    }
  } catch { /* partial body is fine */ }
  try { await reader.cancel(); } catch {}
  return out.slice(0, maxBytes);
}

async function fetchWithTimeout(url, { method = "GET", timeoutMs = 15_000, wantBody = false } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      redirect: "follow",
      credentials: "include",
      signal: controller.signal,
      headers: { "Accept": "text/html,application/xhtml+xml,*/*;q=0.8" }
    });
    let body = "";
    if (wantBody && method !== "HEAD") body = await readBodyPrefix(res);
    else if (res.body) { try { await res.body.cancel(); } catch {} }
    return { status: res.status, finalUrl: res.url || url, redirected: !!res.redirected, body, error: null };
  } catch (err) {
    return { status: 0, finalUrl: url, redirected: false, body: "", error: String(err?.name === "AbortError" ? "timeout" : (err?.message || err)) };
  } finally {
    clearTimeout(timer);
  }
}

// Probe the site's not-found behaviour with two guaranteed-nonexistent URLs
// (one shallow, one deep — some sites route them differently).
async function probeNotFoundBehaviour(origin, timeoutMs) {
  const rand = () => Math.random().toString(36).slice(2, 12);
  const probes = [
    `${origin}/eu404probe-${rand()}`,
    `${origin}/eu404probe-${rand()}/${rand()}`
  ];
  const results = [];
  for (const p of probes) {
    results.push(await fetchWithTimeout(p, { wantBody: true, timeoutMs }));
  }
  const usable = results.filter(r => !r.error);
  if (!usable.length) return { mode: "unknown", signature: null, probeStatuses: results.map(r => r.status) };

  // If ANY probe returns a proper error status, statuses are trustworthy.
  if (usable.some(r => r.status === 404 || r.status === 410)) {
    return { mode: "status", signature: null, probeStatuses: usable.map(r => r.status) };
  }
  const redirHome = usable.filter(r => r.status >= 200 && r.status < 300 && r.redirected && isHomepage(r.finalUrl, origin));
  if (redirHome.length === usable.length) {
    return { mode: "redirect-home", signature: null, probeStatuses: usable.map(r => r.status) };
  }
  const soft = usable.find(r => r.status >= 200 && r.status < 300 && r.body);
  if (soft) {
    const text = normalizeText(soft.body);
    return {
      mode: "soft",
      signature: { shingles: shingles(text), ...extractTitle(soft.body) },
      probeStatuses: usable.map(r => r.status)
    };
  }
  return { mode: "unknown", signature: null, probeStatuses: usable.map(r => r.status) };
}

function classify(result, { origin, targetUrl, baseline }) {
  const { status, finalUrl, redirected, body, error } = result;
  if (error) return { kind: "unreachable", detail: error };
  if (status === 404 || status === 410) return { kind: "hard-404", detail: `HTTP ${status}` };
  if (status >= 500) return { kind: "server-error", detail: `HTTP ${status}` };
  if (status === 401 || status === 403) return { kind: "access-blocked", detail: `HTTP ${status} — may be fine for logged-in users` };
  if (status >= 400) return { kind: "client-error", detail: `HTTP ${status}` };

  const landedOnHome = redirected && isHomepage(finalUrl, origin) && !isHomepage(targetUrl, origin);
  if (landedOnHome) return { kind: "redirect-to-home", detail: `redirects to ${finalUrl}` };

  if (status >= 200 && status < 300 && body) {
    const { title, h1 } = extractTitle(body);
    if (SOFT404_TITLE_RX.test(title) || SOFT404_TITLE_RX.test(h1)) {
      return { kind: "soft-404", detail: `not-found wording in ${SOFT404_TITLE_RX.test(title) ? `title "${title.slice(0, 80)}"` : `h1 "${h1.slice(0, 80)}"`}` };
    }
    if (baseline?.mode === "soft" && baseline.signature) {
      const sim = jaccard(shingles(normalizeText(body)), baseline.signature.shingles);
      if (sim >= SOFT404_SIMILARITY) {
        return { kind: "soft-404", detail: `body matches the site's not-found page (${Math.round(sim * 100)}% similar)` };
      }
    }
  }
  return { kind: "ok", detail: `HTTP ${status}` };
}

// ─────────────────────────────────────────────────────────────────────────
// v0.4.4 — RENDERED-DOM soft-404 layer. The raw-fetch layer above can't see
// SPA not-found pages (server answers 200 + app shell; JavaScript renders
// "page not found" afterwards). Since the crawler renders every page in a
// real tab anyway, this layer fingerprints the site's RENDERED not-found
// page (background.js opens a nonexistent URL in a worker tab) and compares
// every crawled page's rendered content against it.
// ─────────────────────────────────────────────────────────────────────────

// Injected into pages via chrome.scripting.executeScript — must be fully
// self-contained (no references to module scope). Collects the rendered
// title, headings, and a shingle-hash signature of the MAIN content only
// (header/footer/nav/aside stripped, so shared page chrome can't cause a
// thin real page to false-positive against the not-found template).
export function collectRendered404Signals() {
  const norm = (s) => String(s || "").replace(/\s+/g, " ").trim().toLowerCase();
  const title = norm(document.title);
  const h1s = [];
  try {
    for (const el of document.querySelectorAll("h1, h2")) {
      const t = norm(el.textContent);
      if (t) h1s.push(t);
      if (h1s.length >= 4) break;
    }
  } catch {}
  let text = "";
  try {
    const clone = document.body ? document.body.cloneNode(true) : null;
    if (clone) {
      for (const sel of ["header", "footer", "nav", "aside", "script", "style", "noscript", "[role=banner]", "[role=contentinfo]", "[role=navigation]"]) {
        for (const el of clone.querySelectorAll(sel)) { try { el.remove(); } catch {} }
      }
      text = norm(clone.textContent || "").slice(0, 30000);
    }
  } catch {}
  const words = text.split(" ").filter(Boolean);
  const shingleHashes = [];
  for (let i = 0; i + 5 <= words.length && shingleHashes.length < 3000; i++) {
    const gram = words.slice(i, i + 5).join(" ");
    let h = 0x811c9dc5;
    for (let j = 0; j < gram.length; j++) { h ^= gram.charCodeAt(j); h = Math.imul(h, 0x01000193); }
    shingleHashes.push(h >>> 0);
  }
  // Very short main content still gets one signature hash.
  if (!shingleHashes.length && words.length) {
    const gram = words.join(" ");
    let h = 0x811c9dc5;
    for (let j = 0; j < gram.length; j++) { h ^= gram.charCodeAt(j); h = Math.imul(h, 0x01000193); }
    shingleHashes.push(h >>> 0);
  }
  return { title, h1s, textLen: text.length, shingleHashes };
}

// Compare one page's rendered signals against the rendered not-found
// baseline (may be null — the wording heuristic still runs). Returns a
// verdict object or null when the page looks fine.
export function rendered404Verdict(sig, baseline) {
  if (!sig) return null;
  if (SOFT404_TITLE_RX.test(sig.title || "")) {
    return { kind: "soft-404 (rendered)", detail: `not-found wording in rendered title "${(sig.title || "").slice(0, 80)}"` };
  }
  for (const h of sig.h1s || []) {
    if (SOFT404_TITLE_RX.test(h)) {
      return { kind: "soft-404 (rendered)", detail: `not-found wording in rendered heading "${h.slice(0, 80)}"` };
    }
  }
  if (baseline && baseline.shingles && baseline.shingles.size && (sig.shingleHashes || []).length) {
    let inter = 0;
    for (const h of sig.shingleHashes) if (baseline.shingles.has(h)) inter++;
    const sim = inter / (sig.shingleHashes.length + baseline.shingles.size - inter);
    if (sim >= SOFT404_SIMILARITY) {
      return { kind: "soft-404 (rendered)", detail: `rendered content matches the site's not-found page (${Math.round(sim * 100)}% similar)` };
    }
  }
  return null;
}

// linkGraph: Map<targetUrl, { sources: Map<sourceUrl, linkText> }>
export async function detectBrokenLinks({
  linkGraph,
  origin,
  concurrency = 16,
  perUrlTimeoutMs = 15_000,
  maxTargets = 8_000,
  onProgress = null
} = {}) {
  const targets = [...(linkGraph?.keys() || [])]
    .filter(u => { try { return /^https?:$/.test(new URL(u).protocol); } catch { return false; } });

  const truncated = targets.length > maxTargets;
  const toCheck = truncated ? targets.slice(0, maxTargets) : targets;

  const baseline = origin
    ? await probeNotFoundBehaviour(origin, perUrlTimeoutMs)
    : { mode: "unknown", signature: null, probeStatuses: [] };

  // When the site serves soft 404s we need bodies for every 200 answer, so
  // skip the HEAD fast path entirely. Otherwise HEAD first, GET fallback.
  const needBodies = baseline.mode === "soft";

  const rows = [];
  let done = 0;
  let okCount = 0;
  const queue = toCheck.slice();

  async function worker() {
    while (queue.length) {
      const url = queue.shift();
      if (!url) break;
      let result;
      if (needBodies) {
        result = await fetchWithTimeout(url, { method: "GET", wantBody: true, timeoutMs: perUrlTimeoutMs });
      } else {
        result = await fetchWithTimeout(url, { method: "HEAD", timeoutMs: perUrlTimeoutMs });
        // Many servers refuse or mishandle HEAD (405/501, some 400/403/timeouts).
        // Anything other than a clean 2xx/3xx/404/410 gets one GET retry with
        // body so the soft-404 title heuristic can also run.
        const retriable = result.error || result.status === 405 || result.status === 501 ||
          (result.status >= 400 && result.status !== 404 && result.status !== 410);
        if (retriable) {
          result = await fetchWithTimeout(url, { method: "GET", wantBody: true, timeoutMs: perUrlTimeoutMs });
        }
      }
      const verdict = classify(result, { origin, targetUrl: url, baseline });
      done++;
      if (onProgress && (done % 25 === 0 || done === toCheck.length)) {
        try { onProgress(done, toCheck.length); } catch {}
      }
      if (verdict.kind === "ok") { okCount++; continue; }
      const entry = linkGraph.get(url);
      const sources = entry ? [...entry.sources.entries()] : [];
      rows.push({
        url,
        classification: verdict.kind,
        detail: verdict.detail,
        status: result.status,
        final_url: result.finalUrl !== url ? result.finalUrl : "",
        source_count: sources.length,
        sources: sources.map(([src, text]) => text ? `${src}  ["${text}"]` : src).join("\n"),
        first_source: sources[0]?.[0] || "",
        first_link_text: sources[0]?.[1] || ""
      });
    }
  }

  await Promise.all(Array.from({ length: Math.max(1, Math.min(concurrency, toCheck.length)) }, worker));

  // Severity-ish ordering: definite breakage first, informational last.
  const ORDER = { "hard-404": 0, "soft-404": 1, "server-error": 2, "redirect-to-home": 3, "unreachable": 4, "client-error": 5, "access-blocked": 6 };
  rows.sort((a, b) => (ORDER[a.classification] ?? 9) - (ORDER[b.classification] ?? 9) || b.source_count - a.source_count);

  return {
    checked: done,
    totalTargets: targets.length,
    truncated,
    okCount,
    brokenCount: rows.filter(r => r.classification !== "access-blocked").length,
    notFoundMode: baseline.mode,
    probeStatuses: baseline.probeStatuses,
    rows
  };
}
