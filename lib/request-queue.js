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

// Block list philosophy (v12, revised from v6):
//
// The goal is "every page a human can reach, and ONLY those". Blocking
// splits into two semantic categories:
//
// (A) HARD-BLOCK — URLs a human cannot click through to as a page:
//   • Admin panels (require login)
//   • Machine endpoints (JSON / XML-RPC / cron RPC)
//   • Plugin internal URLs that 500/404 for non-logged-in visitors
//   • Build-time template placeholder bugs (never resolve to real pages)
//   • File downloads (not HTML — handled by NON_CRAWLABLE_EXT)
//
// (B) ARCHIVE-BLOCK — URLs that ARE human-clickable but duplicate the
//     audit template of their parent listing without adding unique
//     audit-relevant content:
//   • /tag/, /category/, /author/, /date/, /attachment/, /archive/
//     — filing-cabinet views sharing the main-listing template
//   • /page/N/ pagination — every paginated URL is the same template
//     with swapped content cards; audit one page → cover the template
//
// The v6 philosophy treated category (B) as in-scope because humans
// CAN click to them. v12 reverses that because the user's phantom-
// avoidance requirement outweighs exhaustive discovery — these URLs
// inflate the inventory with near-duplicates of already-audited
// templates and dilute the signal in the report. Archive prefixes
// are added to ARCHIVE_PATH_PREFIXES; pagination collapses in
// canonicalize() to its unpaginated parent.
const BLOCKED_PATH_PREFIXES = [
  // WordPress admin + machine endpoints
  "/wp-admin",
  "/wp-json",
  "/wp-login.php",
  "/xmlrpc.php",
  "/wp-cron.php",
  "/wp-trackback.php",
  "/wp-comments-post.php",
  // Popup Builder plugin — exposes modal-config URLs like
  // /popupbuilder/<popup-slug>. Not a page a human clicks to — it's the
  // plugin's internal endpoint for configured popups. Commonly 404s or
  // renders a redirected landing page.
  "/popupbuilder",
  // Generic
  "/cgi-bin"
];

// "The Gem" theme / "Gem Team" plugin CPT taxonomy endpoints. These are
// plugin internal URLs that return 500 errors for anonymous visitors —
// not human-reachable content pages. Pattern: `/tgr_member_<taxonomy>`.
//   /tgr_member_filters/<slug>, /tgr_member_fields/<slug>, /tgr_member_skills/<slug>
const TGR_MEMBER_RX = /^\/tgr_member_/i;

// Archive-template URL prefixes — see "ARCHIVE-BLOCK" in the philosophy
// comment above. Matched at path start; both "/tag" and "/tag/javascript"
// are filtered, but "/tagline-generator" (no trailing slash or end) is
// left alone because that's a real content path that merely starts with
// the letters "tag".
const ARCHIVE_PATH_PREFIXES = [
  "/tag", "/tags",
  "/category", "/categories", "/cat",
  "/author", "/authors",
  "/date", "/year",
  "/attachment",
  "/archive", "/archives"
];

// Pagination segment matcher. WordPress and most CMSes expose paginated
// listings as "/blog/page/2/", "/news/page/3/", or bare "/page/5/". Every
// paginated URL renders the identical template (cards grid + pagination
// nav); auditing one page already captures the template posture. The
// canonicalizer collapses all /page/N/ segments so the unpaginated parent
// URL is the only one that enters the queue.
const PAGINATION_SEGMENT_RX = /\/page\/\d+(?=\/|$)/gi;

// Query-string blocks. Kept minimal — only params that indicate the URL
// is NOT a human-clickable destination:
//   ?replytocom=NNN     — "Reply to this comment" anchor (comment form state,
//                         not a page)
//   ?share=…            — social-share button URL (no unique content — the
//                         button opens Twitter/FB/etc., not a new page on
//                         this site)
//   ?print=…            — print view of an already-crawled page
// Matched as `param in u.searchParams` (presence only, value-agnostic).
//
// The WordPress permalink-fallback params (?p, ?page_id, ?cat, ?tag,
// ?author, ?attachment_id) are intentionally NOT blocked. On sites where
// pretty-permalinks are disabled, ?p=123 is the real URL for the post, not
// a duplicate of anything. Let exact-URL dedup handle cases where both
// the pretty URL and the fallback URL get discovered.
//
// Modal-state params (?open, ?modal, ?dialog, ?popup, ?popover) are also
// NOT blocked — these ARE human-reachable (portfolio cards, team tiles,
// etc. encode their state in the URL so a visitor can share the deep
// link). Each modal state is a distinct user-visible screen.
const BLOCKED_QUERY_PARAMS = new Set([
  "replytocom", "share", "print"
]);

// Placeholder href patterns. Some JS frameworks / CMS plugins render
// unbound template fragments directly into the nav DOM — strings like
// `/team/member_7d84d8bf` or `/insights/item_4db2c79f` where the hex
// suffix is a build-time placeholder that was never replaced with a
// real slug. The server 404s them; the crawler burns a URL slot and
// a tab-open on each. Pattern: a path segment ending in
// `_<6+ hex digits>` (always hex, never decimal — rules out real
// slugs like `/articles/report-2024`). Match is on the last path
// segment only so we never over-match something like `/press_release`
// (no hex suffix).
const PLACEHOLDER_HEX_RX = /^[A-Za-z][A-Za-z0-9-]*_[0-9a-f]{6,}$/;

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

  // Placeholder-hex basename (see PLACEHOLDER_HEX_RX definition above).
  if (basename && PLACEHOLDER_HEX_RX.test(basename)) return false;

  // Path-prefix check. Match if the path equals the prefix, OR begins with
  // "<prefix>/…", OR begins with "<prefix>?…" (bare-file admin endpoints
  // like /wp-login.php often have query strings).
  for (const pre of BLOCKED_PATH_PREFIXES) {
    if (path === pre || path.startsWith(pre + "/") || path.startsWith(pre + "?")) return false;
  }

  // The Gem theme's tgr_member_* taxonomy endpoints (plugin internal,
  // returns 500 for anonymous visitors).
  if (TGR_MEMBER_RX.test(path)) return false;

  // Archive-template prefixes (tag/category/author/date/attachment archives).
  // See "ARCHIVE-BLOCK" in the philosophy comment above.
  for (const pre of ARCHIVE_PATH_PREFIXES) {
    if (path === pre || path.startsWith(pre + "/")) return false;
  }

  // Query-string blocks (replytocom / share / print only — see
  // BLOCKED_QUERY_PARAMS comment for rationale).
  for (const k of u.searchParams.keys()) {
    if (BLOCKED_QUERY_PARAMS.has(k.toLowerCase())) return false;
  }

  return true;
}

// Common directory-index filenames that the server serves transparently
// as the parent directory URL. /about/ and /about/index.html are the same
// page on every webserver in existence; /contact.aspx and /contact/default.aspx
// are the same on IIS-hosted sites. Collapsing these at the canonicalizer
// level removes a real-world source of duplicate rows in the report.
// Matched against the basename (last path segment), case-insensitive.
const INDEX_FILE_RX = /^(index|default|home)\.(html?|php|aspx?|jsp)$/i;

// Session-id URL-embedded parameters. Java servlet containers (Tomcat,
// WebLogic, JBoss) append `;jsessionid=XXXX` to every internal link when
// cookies are disabled client-side; ASP.NET does a similar thing with
// path-embedded tokens. Both produce a fresh "distinct" URL per visitor
// session that points at the exact same page. We also catch the less
// common `;sid=`, `;phpsessid=`, `;session=`, `;s=` variants.
const PATH_SESSION_RX = /;(jsessionid|sid|phpsessid|session|s)=[^\/;?#]+/gi;

export function canonicalize(raw, base) {
  try {
    const u = new URL(raw, base);
    if (u.protocol !== "http:" && u.protocol !== "https:") return null;
    u.hash = "";
    // Strip default ports
    if ((u.protocol === "http:" && u.port === "80") ||
        (u.protocol === "https:" && u.port === "443")) u.port = "";
    // Strip path-embedded session ids before the slash + index-file passes
    // — `;jsessionid=XXX` can appear on any segment and removing it may
    // leave a segment that the trailing-slash collapse will then tidy up.
    if (PATH_SESSION_RX.test(u.pathname)) {
      u.pathname = u.pathname.replace(PATH_SESSION_RX, "");
    }
    // Collapse pagination segments (/blog/page/2/ → /blog/). Every paginated
    // URL renders the same template with swapped content; collapsing to the
    // unpaginated parent ensures we enqueue the listing once and audit the
    // template posture rather than N times for N paginated slices.
    if (PAGINATION_SEGMENT_RX.test(u.pathname)) {
      u.pathname = u.pathname.replace(PAGINATION_SEGMENT_RX, "");
      if (!u.pathname) u.pathname = "/";
    }
    // Collapse directory-index filenames to the parent directory form.
    // `/about/index.html` → `/about/`, `/contact/default.aspx` → `/contact/`.
    // The server serves both URLs identically — collapsing at write time
    // stops the same page appearing twice when one link uses `/about/` and
    // another uses `/about/index.html`.
    const lastSlash = u.pathname.lastIndexOf("/");
    if (lastSlash >= 0) {
      const basename = u.pathname.slice(lastSlash + 1);
      if (basename && INDEX_FILE_RX.test(basename)) {
        u.pathname = u.pathname.slice(0, lastSlash + 1);
      }
    }
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

// www-insensitive hostname comparison. `www.example.com` and `example.com`
// are almost always the same site served under two names (the hosting
// provider redirects one to the other). Treating them as different sites
// meant the scope crawler would refuse to follow half the nav when the
// seed URL and the declared canonical/sitemap hostname disagreed on the
// `www.` prefix — a common cause of "only the homepage got scanned" on
// WordPress + CloudFlare setups.
//
// This is intentionally conservative — ONLY the leading `www.` is
// stripped. Other subdomains (blog.example.com, shop.example.com) stay
// distinct because they frequently ARE separate sites with separate
// audit scopes.
function stripWww(host) {
  return host && host.startsWith("www.") ? host.slice(4) : host;
}

export function sameHostname(a, b) {
  try {
    return stripWww(new URL(a).hostname) === stripWww(new URL(b).hostname);
  } catch { return false; }
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

// Per-origin adaptive rate limiter + circuit breaker + concurrency cap.
// Start 300ms between requests per origin; 2x on 429/503, 1.5x on 5xx,
// 0.85x decay on success. 5 consecutive hard failures -> circuit tripped 60s.
//
// perOriginMax caps how many tabs can be simultaneously open against the
// same origin. Without this, a global CONCURRENT_TABS=200 on a single-origin
// site meant 200 tabs all racing each other + the target server — Chrome's
// network loader pool, renderer memory, and the server's per-IP limits all
// start failing. The RateLimiter's pacing (300ms gap) is NOT a concurrency
// cap: it only staggers starts; once a page is being fetched/rendered, a
// worker is holding a tab against the origin until it settles. On a slow
// 10-second page, 200 workers all progress into "active" within 60 seconds
// and sit there together.
//
// perOriginMax solves this by making `wait()` a two-stage gate:
//   1. the existing rate-limit delay (pacing)
//   2. a semaphore — block until s.active < perOriginMax, then increment
// The caller MUST call `release(url)` in a finally to decrement, otherwise
// the semaphore leaks and the origin eventually stalls.
//
// Default 8 is empirical: enough parallelism to finish a medium site in
// reasonable time, small enough not to trip Cloudflare/Akamai per-IP rate
// limits or exhaust Chrome's renderer pool on a single origin.
export class RateLimiter {
  constructor(opts = {}) {
    this.state = new Map(); // origin -> { delay, nextOk, fails, breakerUntil, ok, err, active }
    this.perOriginMax = Number.isFinite(opts.perOriginMax) && opts.perOriginMax > 0
      ? opts.perOriginMax
      : 0; // 0 = no cap (legacy behavior)
  }

  _get(origin) {
    let s = this.state.get(origin);
    if (!s) {
      s = { delay: 300, nextOk: 0, fails: 0, breakerUntil: 0, ok: 0, err: 0, active: 0 };
      this.state.set(origin, s);
    }
    return s;
  }

  // Returns an object { origin } used by release(). Returns null if the URL
  // is unparseable (the caller then doesn't need to release).
  async wait(url) {
    let origin;
    try { origin = new URL(url).origin; } catch { return null; }
    const s = this._get(origin);

    // Stage 1: circuit breaker
    const now = Date.now();
    if (s.breakerUntil && now < s.breakerUntil) {
      const w = s.breakerUntil - now;
      await sleep(w);
      s.breakerUntil = 0;
    }

    // Stage 2: per-origin concurrency cap. Poll-wait (not a proper promise
    // queue) because this gets called by at most CONCURRENT_TABS workers —
    // on the order of 200 — and each poll is a 50ms sleep. A fancy semaphore
    // with waiter queues would be more elegant but this is simple and has
    // no correctness issues as long as callers pair wait() with release().
    if (this.perOriginMax > 0) {
      while (s.active >= this.perOriginMax) {
        await sleep(50);
      }
    }
    s.active++;

    // Stage 3: pacing (rate-limit gap)
    const now2 = Date.now();
    const wait = Math.max(0, s.nextOk - now2);
    if (wait > 0) await sleep(wait);
    s.nextOk = Date.now() + s.delay;

    return { origin };
  }

  // MUST be called in finally after wait() returns a non-null token. Missing
  // a release() call leaks a semaphore slot and can stall the origin's
  // workers permanently.
  release(url) {
    let origin;
    try { origin = new URL(url).origin; } catch { return; }
    const s = this.state.get(origin);
    if (!s) return;
    s.active = Math.max(0, s.active - 1);
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
    for (const [o, s] of this.state) {
      out[o] = { delay: Math.round(s.delay), ok: s.ok, err: s.err, active: s.active };
    }
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
