// Crawlee-style request queue for MV3 service worker.
// Dedup by canonical URL, depth tracking, per-origin adaptive rate limit,
// retry with exponential backoff on 429/503 + Retry-After parsing.
// No external deps; runs inside the SW.

// ──────────────────────────────────────────────────────────────────────
// Crawl-gate filter. URLs matching these are never enqueued regardless of
// where they were discovered (sitemap, nav, feed, hreflang, body-link).
// PDF is intentionally NOT in the blocked extensions — we crawl PDFs since
// they're in-scope for a full site accessibility audit. Images / video /
// audio / spreadsheets / docs / archives / fonts / code / installers are
// all skipped.
//
// Path-prefix blocks cover WordPress admin + machine endpoints that either
// require login (no rendered page to audit) or are non-HTML RPC/JSON.
// Adding to these arrays is the single place to extend the block list.
// ──────────────────────────────────────────────────────────────────────
const NON_CRAWLABLE_EXT = new Set([
  // Images
  "png", "jpg", "jpeg", "gif", "svg", "ico", "webp", "avif", "bmp", "tiff", "tif", "heic", "heif",
  // Video
  "mp4", "webm", "m4v", "mkv", "avi", "mov", "wmv", "flv", "ogv", "3gp",
  // Audio
  "mp3", "wav", "m4a", "flac", "ogg", "opus", "aac", "wma",
  // Office (EXCEPT pdf — we crawl PDFs)
  "xls", "xlsx", "xlsm", "xlsb", "csv", "tsv", "ods",
  "doc", "docx", "dot", "dotx", "odt", "rtf",
  "ppt", "pptx", "odp",
  // Archives
  "zip", "tar", "gz", "bz2", "7z", "rar", "br", "xz",
  // Fonts
  "woff", "woff2", "ttf", "otf", "eot",
  // Code / data
  "js", "mjs", "css", "json", "xml", "txt", "map", "yaml", "yml",
  // Binaries / installers
  "exe", "dmg", "msi", "apk", "ipa", "pkg", "deb", "rpm", "iso", "bin"
]);

const BLOCKED_PATH_PREFIXES = [
  // WordPress admin + machine endpoints
  "/wp-admin",
  "/wp-json",
  "/wp-login.php",
  "/xmlrpc.php",
  "/wp-cron.php",
  "/wp-trackback.php",
  "/wp-comments-post.php",
  // Generic
  "/cgi-bin"
];

export function isCrawlablePath(urlString) {
  let u;
  try { u = new URL(urlString); } catch { return false; }
  const path = u.pathname.toLowerCase();

  // Extension check against the last segment only. `/foo.png/bar` is a
  // valid HTML path (basename has no dot), so we check basename, not path.
  const lastSlash = path.lastIndexOf("/");
  const basename = lastSlash >= 0 ? path.slice(lastSlash + 1) : path;
  const dot = basename.lastIndexOf(".");
  if (dot > 0) {
    const ext = basename.slice(dot + 1);
    if (NON_CRAWLABLE_EXT.has(ext)) return false;
  }

  // Path-prefix check. Match if the path equals the prefix, OR begins with
  // "<prefix>/…", OR begins with "<prefix>?…" (bare-file admin endpoints
  // like /wp-login.php often have query strings).
  for (const pre of BLOCKED_PATH_PREFIXES) {
    if (path === pre || path.startsWith(pre + "/") || path.startsWith(pre + "?")) return false;
  }
  return true;
}

export function canonicalize(raw, base) {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    // Strip default ports
    if ((u.protocol === "http:" && u.port === "80") ||
        (u.protocol === "https:" && u.port === "443")) u.port = "";
    // Collapse trailing slash except for root
    if (u.pathname.length > 1 && u.pathname.endsWith("/")) {
      u.pathname = u.pathname.replace(/\/+$/, "");
    }
    // Strip tracking + "redirect-after" params. The latter group catches
    // disclosure-gate / login-gate sites that redirect every URL to the same
    // gate page but encode the originally-requested URL as a query param
    // (`?next=/about`, `?next=/services`, etc.) — without stripping, each
    // worker's settled URL would look unique and dedup would miss.
    const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|_ga$|_gl$|next$|return$|return_to$|returnurl$|redirect$|redirect_to$|redirectto$|back$|back_url$|backurl$|from$|source_page$|callback$|origin$|continue$|dest$|destination$)/i;
    const keep = [];
    for (const [k, v] of u.searchParams.entries()) {
      if (!TRACKING.test(k)) keep.push([k, v]);
    }
    keep.sort((a, b) => a[0].localeCompare(b[0]));
    u.search = "";
    for (const [k, v] of keep) u.searchParams.append(k, v);
    return u.toString();
  } catch {
    return null;
  }
}

export function sameHostname(a, b) {
  try { return new URL(a).hostname === new URL(b).hostname; } catch { return false; }
}

export function sameOrigin(a, b) {
  try { return new URL(a).origin === new URL(b).origin; } catch { return false; }
}

export class RequestQueue {
  constructor({ scopeUrl, maxUrls = 50, maxDepth = 1, scope = "same-hostname" } = {}) {
    this.scopeUrl = scopeUrl;
    this.maxUrls = maxUrls;
    this.maxDepth = maxDepth;
    this.scope = scope;
    this.seen = new Set();
    // URLs that a tab actually landed on after following server redirects.
    // Tracked separately from `seen` (which is the enqueued URL set) so we
    // can skip redundant scans on disclosure-gate / age-gate / session-wall
    // sites where every URL redirects to the same landing page.
    this.settledSeen = new Set();
    this.queue = [];
    this.processed = 0;
  }

  // Dedup key for settled URLs. Two modes:
  //   • If settled pathname matches the originally-requested pathname, there
  //     was no redirect — use the full canonical URL (query params may be
  //     meaningful, e.g. pagination: /blog?page=1 vs /blog?page=2).
  //   • If settled pathname DIFFERS from the originally-requested pathname,
  //     a redirect happened. Dedup by origin + pathname only (query params
  //     on the redirected-to page are typically session/return-path hints,
  //     not content distinguishers).
  // originalRaw is optional — without it we always use pathname-only,
  // which is a conservative fallback.
  _settledKey(rawUrl, originalRaw) {
    try {
      const settled = new URL(rawUrl);
      const normPath = p => (p.length > 1 ? p.replace(/\/+$/, "") : p);
      const settledPath = normPath(settled.pathname);
      const base = settled.origin + settledPath;
      if (!originalRaw) return base;
      const original = new URL(originalRaw);
      if (normPath(original.pathname) === settledPath) {
        // No redirect — use full canonical (query params may matter)
        return canonicalize(rawUrl, this.scopeUrl);
      }
      return base;
    } catch { return null; }
  }

  hasSettled(rawUrl, originalRaw = null) {
    const key = this._settledKey(rawUrl, originalRaw);
    return key ? this.settledSeen.has(key) : false;
  }

  markSettled(rawUrl, originalRaw = null) {
    const key = this._settledKey(rawUrl, originalRaw);
    if (key) this.settledSeen.add(key);
    return key;
  }

  inScope(url) {
    if (!this.scopeUrl) return true;
    return this.scope === "same-origin"
      ? sameOrigin(url, this.scopeUrl)
      : sameHostname(url, this.scopeUrl);
  }

  enqueue(rawUrl, { depth = 0, priority = 0, source = "link" } = {}) {
    const url = canonicalize(rawUrl, this.scopeUrl);
    if (!url) return false;
    if (this.seen.has(url)) return false;
    if (!this.inScope(url)) return false;
    // Seed URL is always honoured — if a user explicitly seeds on a
    // wp-admin page or a PDF we respect that. Every other source
    // (nav/sitemap/feed/etc.) goes through the crawl-gate filter.
    if (source !== "seed" && !isCrawlablePath(url)) return false;
    if (depth > this.maxDepth) return false;
    if (this.seen.size >= this.maxUrls) return false;
    this.seen.add(url);
    this.queue.push({ url, depth, priority, source });
    // Higher priority first; ties by depth (shallower first)
    this.queue.sort((a, b) => (b.priority - a.priority) || (a.depth - b.depth));
    return true;
  }

  enqueueMany(urls, opts = {}) {
    let added = 0;
    for (const u of urls) if (this.enqueue(u, opts)) added++;
    return added;
  }

  next() {
    const r = this.queue.shift();
    if (r) this.processed++;
    return r;
  }

  get pending() { return this.queue.length; }
  get total() { return this.seen.size; }
  get remaining() { return Math.max(0, this.maxUrls - this.processed); }
}

// Per-origin adaptive rate limiter + circuit breaker.
// Start 300ms between requests per origin; 2x on 429/503, 1.5x on 5xx,
// 0.85x decay on success. 5 consecutive hard failures -> circuit tripped 60s.
export class RateLimiter {
  constructor() {
    this.state = new Map(); // origin -> { delay, nextOk, fails, breakerUntil, ok, err }
  }

  _get(origin) {
    let s = this.state.get(origin);
    if (!s) {
      s = { delay: 300, nextOk: 0, fails: 0, breakerUntil: 0, ok: 0, err: 0 };
      this.state.set(origin, s);
    }
    return s;
  }

  async wait(url) {
    let origin;
    try { origin = new URL(url).origin; } catch { return; }
    const s = this._get(origin);
    const now = Date.now();
    if (s.breakerUntil && now < s.breakerUntil) {
      // Half-open: wait the remainder, then try
      const w = s.breakerUntil - now;
      await sleep(w);
      s.breakerUntil = 0;
    }
    const wait = Math.max(0, s.nextOk - now);
    if (wait > 0) await sleep(wait);
    s.nextOk = Date.now() + s.delay;
  }

  reportSuccess(url) {
    let origin; try { origin = new URL(url).origin; } catch { return; }
    const s = this._get(origin);
    s.ok++;
    s.fails = 0;
    s.delay = Math.max(150, s.delay * 0.85);
  }

  reportFailure(url, { status = 0, retryAfterSec = 0 } = {}) {
    let origin; try { origin = new URL(url).origin; } catch { return; }
    const s = this._get(origin);
    s.err++;
    if (status === 429 || status === 503) {
      s.delay = Math.min(30000, s.delay * 2);
      if (retryAfterSec > 0) s.nextOk = Date.now() + Math.min(120000, retryAfterSec * 1000);
    } else if (status >= 500) {
      s.delay = Math.min(30000, s.delay * 1.5);
      s.fails++;
    } else {
      s.fails++;
    }
    if (s.fails >= 5) {
      s.breakerUntil = Date.now() + 60000;
      s.fails = 0;
    }
  }

  snapshot() {
    const out = {};
    for (const [o, s] of this.state) out[o] = { delay: Math.round(s.delay), ok: s.ok, err: s.err };
    return out;
  }
}

export function parseRetryAfter(value) {
  if (!value) return 0;
  const n = Number(value);
  if (Number.isFinite(n)) return Math.max(0, n);
  const d = Date.parse(value);
  if (!Number.isNaN(d)) return Math.max(0, Math.round((d - Date.now()) / 1000));
  return 0;
}

export async function retryWithBackoff(fn, { max = 4, baseMs = 1000, limiter = null, url = "" } = {}) {
  let lastErr;
  for (let attempt = 0; attempt < max; attempt++) {
    if (limiter) await limiter.wait(url);
    try {
      const r = await fn(attempt);
      if (limiter) limiter.reportSuccess(url);
      return r;
    } catch (err) {
      lastErr = err;
      const status = err?.status || 0;
      const retryAfter = err?.retryAfterSec || 0;
      if (limiter) limiter.reportFailure(url, { status, retryAfterSec: retryAfter });
      if (status && status < 500 && status !== 429 && status !== 408) throw err;
      const delay = Math.min(30000, baseMs * 2 ** attempt) + Math.random() * 300;
      await sleep(delay);
    }
  }
  throw lastErr || new Error("retry exhausted");
}

function sleep(ms) { return new Promise(r => setTimeout(r, ms)); }
