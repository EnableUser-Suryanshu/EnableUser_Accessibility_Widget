// Crawlee-style request queue for MV3 service worker.
// Dedup by canonical URL, depth tracking, per-origin adaptive rate limit,
// retry with exponential backoff on 429/503 + Retry-After parsing.
// No external deps; runs inside the SW.

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
    // Strip tracking params
    const TRACKING = /^(utm_|fbclid$|gclid$|mc_|ref$|ref_src$|_ga$|_gl$)/i;
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
    this.queue = [];
    this.processed = 0;
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
