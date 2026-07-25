// Out-of-band URL discovery sources. All cheap (no tab), HEAD/GET only.
// Evidence-based: sitemap deep walk (depth 5), robots.txt Sitemap directives,
// hreflang alternates. NO speculative common-path probing — on SPAs every
// path returns 200 (the server ships the shell HTML and lets the client
// router decide what to render), so a HEAD-probe of hardcoded guesses like
// /login, /signup, /privacy-policy produces 40 false-positive URLs that all
// render the same empty shell. Real pages come from declared sources only.
//
// The in-page "nav-first seeding" + click-reveal helpers live here too; they
// run via chrome.scripting.executeScript in the target tab.

import { canonicalize } from "./request-queue.js";

// Sitemaps nest (sitemap-index → sitemap → sitemap …) on large sites —
// some government portals have 5-6 levels of indirection. v11: no caps
// on the walk at all — unbounded depth AND unbounded file count per
// operator decision. The visited-set guarantees termination against
// cycles, and out-of-scope URLs are rejected at the origin check. Sitemap
// walking is cheap (HTTP GET + regex parse, no tab, no axe run), so a
// very large nested sitemap just means a slower discovery phase, not an
// expensive crawl.
const SITEMAP_WALK_DEPTH = Infinity;

// ──────────────────────────────────────────────────────────────────────
// Sitemap / robots.txt discovery
// ──────────────────────────────────────────────────────────────────────

export async function discoverSeedsFromOrigin(origin) {
  const candidates = new Set([
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/wp-sitemap.xml`,
    `${origin}/sitemap-index.xml`,
    // Plain-text sitemap format (sitemaps.org §3 "Alternative format"):
    // one absolute URL per line, optional "#" comment lines, blank
    // lines ignored. Used by static-site generators (Hugo, Eleventy,
    // Jekyll plugins) and a small fraction of CMSes. walkSitemap
    // auto-detects format based on the first bytes of the response.
    `${origin}/sitemap.txt`
  ]);
  try {
    const res = await fetch(`${origin}/robots.txt`, { credentials: "omit", cache: "no-store" });
    if (res.ok) {
      const txt = await res.text();
      for (const m of txt.matchAll(/^\s*sitemap:\s*(\S+)/gim)) {
        try { candidates.add(new URL(m[1], origin).toString()); } catch {}
      }
    }
  } catch {}
  const found = new Set();
  const visited = new Set();
  for (const sm of candidates) {
    await walkSitemap(sm, origin, visited, found, 0);
  }
  return [...found];
}

async function walkSitemap(sitemapUrl, origin, visited, found, depth) {
  if (depth > SITEMAP_WALK_DEPTH || visited.has(sitemapUrl)) return;
  visited.add(sitemapUrl);
  let text;
  try {
    const res = await fetch(sitemapUrl, { credentials: "omit", cache: "no-store" });
    if (!res.ok) return;
    text = await res.text();
  } catch { return; }

  // Format detection (v12): XML sitemaps open with "<?xml" or go straight
  // to "<urlset" / "<sitemapindex". Plain-text sitemaps (sitemaps.org
  // alternative format) have no XML prelude — they're one URL per line.
  // We sniff the first non-whitespace character: "<" → XML path,
  // everything else → try plain-text path. Wrong calls fall through to
  // zero matches safely.
  const head = text.slice(0, 2048).trimStart();
  const isXml = head.startsWith("<");

  if (!isXml) {
    // Plain-text sitemap: each non-empty, non-comment line is an absolute
    // URL. Comments start with "#". We resolve relative URLs against the
    // sitemap URL (some generators emit "/about" instead of a fully
    // schemed URL, which isn't spec-compliant but is common in the wild).
    for (const rawLine of text.split(/\r?\n/)) {
      const line = rawLine.trim();
      if (!line || line.startsWith("#")) continue;
      try {
        const u = new URL(line, sitemapUrl);
        if (u.origin !== origin) continue;
        if (u.protocol !== "http:" && u.protocol !== "https:") continue;
        u.hash = "";
        found.add(u.toString());
      } catch {}
    }
    return;
  }

  const isIndex = /<sitemapindex[\s>]/i.test(text);
  const locs = [...text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => m[1]);

  if (isIndex) {
    for (const loc of locs) {
      try {
        const u = new URL(loc);
        if (u.origin === origin) await walkSitemap(u.toString(), origin, visited, found, depth + 1);
      } catch {}
    }
  } else {
    for (const loc of locs) {
      try {
        const u = new URL(loc);
        if (u.origin !== origin) continue;
        u.hash = "";
        found.add(u.toString());
      } catch {}
    }
  }
}

// ──────────────────────────────────────────────────────────────────────
// Homepage <link rel="..."> harvest — one fetch, five signals.
// Extracts hreflang alternates, rel=canonical, rel=next / rel=prev (W3C
// pagination spec), and rel="alternate" type="application/rss+xml" /
// "application/atom+xml" / "application/feed+json" (RSS/Atom/JSON feed
// autodiscovery). This is cheap — the homepage is already about to be
// scanned — so doing one fetch here saves an HTTP round trip vs fetching
// once per signal.
//
// Returns:
//   {
//     hreflang:  [abs url, ...],   // locale alternates
//     canonical: abs url | null,   // may rewrite the seed
//     nextPrev:  [abs url, ...],   // pagination successors of the seed
//     feeds:     [abs url, ...]    // feeds to parse for entry URLs
//   }
// ──────────────────────────────────────────────────────────────────────

export async function discoverHomepageLinks(homepageUrl) {
  const out = { hreflang: [], canonical: null, nextPrev: [], feeds: [] };
  let html;
  try {
    const res = await fetch(homepageUrl, { credentials: "omit", cache: "no-store" });
    if (!res.ok) return out;
    html = await res.text();
  } catch { return out; }

  // Walk every <link> tag once, then classify by its rel value — faster and
  // more robust than a separate regex per rel type.
  const LINK_RX = /<link\b([^>]*)\/?>/gi;
  const ATTR_RX = /(\w[\w:-]*)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/g;
  const hreflangSet = new Set();
  const nextPrevSet = new Set();
  const feedSet = new Set();
  let canonical = null;

  for (const m of html.matchAll(LINK_RX)) {
    const attrBlob = m[1] || "";
    const attrs = {};
    for (const a of attrBlob.matchAll(ATTR_RX)) {
      attrs[a[1].toLowerCase()] = a[3] ?? a[4] ?? a[5] ?? "";
    }
    const rel = (attrs.rel || "").toLowerCase();
    if (!rel || !attrs.href) continue;
    const abs = canonicalize(attrs.href, homepageUrl);
    if (!abs) continue;

    if (rel.includes("alternate")) {
      if (attrs.hreflang) hreflangSet.add(abs);
      const type = (attrs.type || "").toLowerCase();
      if (
        type.includes("rss") ||
        type.includes("atom") ||
        type.includes("feed+json") ||
        type === "application/json"
      ) feedSet.add(abs);
    }
    if (rel === "canonical" && !canonical) canonical = abs;
    if (rel === "next" || rel === "prev" || rel === "previous") nextPrevSet.add(abs);
  }

  out.hreflang = [...hreflangSet];
  out.canonical = canonical;
  out.nextPrev = [...nextPrevSet];
  out.feeds = [...feedSet];
  return out;
}

// Thin wrapper — kept for backwards compatibility with any code expecting
// the flat hreflang-only list. New code should use discoverHomepageLinks.
export async function discoverHreflang(homepageUrl) {
  const r = await discoverHomepageLinks(homepageUrl);
  return r.hreflang;
}

// ──────────────────────────────────────────────────────────────────────
// RSS / Atom / JSON-feed parsing
//
// Complements the sitemap walk — some sites publish a curated feed
// (latest articles, notifications, press releases) that doesn't appear
// in the sitemap, or is fresher. Government news portals in particular
// frequently ship /rss/ directories that list the last N notifications
// which would otherwise be buried deep in the sitemap.
//
// Accepts both origin-probe URLs (/feed, /feed.xml, /rss.xml, /atom.xml,
// /index.xml) AND feed URLs autodiscovered from the homepage <link>
// tags. Only same-origin entry URLs are returned.
// ──────────────────────────────────────────────────────────────────────

const FEED_PROBE_PATHS = [
  "/feed", "/feed/", "/feed.xml", "/rss", "/rss.xml", "/atom.xml",
  "/index.xml", "/feed/atom/", "/feed.json", "/feed/rss",
  "/rss/latest.xml", "/press-releases/feed", "/news/feed"
];
const FEED_MAX_FILES = 50;   // hard ceiling on feed files fetched per crawl
const FEED_MAX_ENTRIES = 2000; // combined cap across all feeds

export async function discoverFeeds(origin, extraFeedUrls = []) {
  if (!origin) return [];
  const candidates = new Set(extraFeedUrls);
  for (const p of FEED_PROBE_PATHS) candidates.add(origin + p);
  const out = new Set();
  let filesFetched = 0;
  for (const feedUrl of candidates) {
    if (filesFetched >= FEED_MAX_FILES || out.size >= FEED_MAX_ENTRIES) break;
    filesFetched++;
    let body;
    try {
      const res = await fetch(feedUrl, { credentials: "omit", cache: "no-store" });
      if (!res.ok) continue;
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      // Probe paths often return 200 with an HTML error page on sites that
      // don't actually publish a feed — skip those. Discovered feeds always
      // advertise the right content type.
      if (!/xml|rss|atom|json/.test(ct) && !/^<\?xml/i.test(await (res.clone()).text())) continue;
      body = await res.text();
    } catch { continue; }
    if (!body) continue;
    try {
      const entries = parseFeedEntries(body, feedUrl, origin);
      for (const e of entries) {
        if (out.size >= FEED_MAX_ENTRIES) break;
        out.add(e);
      }
    } catch {}
  }
  return [...out];
}

function parseFeedEntries(body, feedUrl, origin) {
  const urls = [];
  // JSON Feed (jsonfeed.org) — items[].url
  if (body.trim().startsWith("{")) {
    try {
      const json = JSON.parse(body);
      const items = Array.isArray(json.items) ? json.items : [];
      for (const it of items) {
        const u = canonicalize(it?.url || it?.external_url || "", feedUrl);
        if (u && new URL(u).origin === origin) urls.push(u);
      }
      return urls;
    } catch { return urls; }
  }
  // RSS 2.0: <item><link>URL</link></item> (and <guid isPermaLink="true">)
  // Atom: <entry><link href="URL"/></entry> (and <id>URL</id> if a URL)
  const linkTagRx = /<link\b([^>]*)(?:\/>|>([^<]*)<\/link>)/gi;
  for (const m of body.matchAll(linkTagRx)) {
    const inner = (m[2] || "").trim();
    const attrBlob = m[1] || "";
    const hrefMatch = attrBlob.match(/href\s*=\s*["']([^"']+)["']/i);
    const relMatch = attrBlob.match(/rel\s*=\s*["']([^"']+)["']/i);
    const rel = (relMatch?.[1] || "").toLowerCase();
    // Skip Atom <link rel="self"|"hub"|"edit"> — those aren't entries.
    if (rel && rel !== "alternate" && rel !== "") continue;
    const raw = hrefMatch?.[1] || inner;
    if (!raw) continue;
    const u = canonicalize(raw, feedUrl);
    if (!u) continue;
    try { if (new URL(u).origin !== origin) continue; } catch { continue; }
    urls.push(u);
  }
  // <guid isPermaLink="true">URL</guid>
  for (const m of body.matchAll(/<guid\b[^>]*isPermaLink\s*=\s*["']true["'][^>]*>\s*([^<]+?)\s*<\/guid>/gi)) {
    const u = canonicalize(m[1], feedUrl);
    if (u) {
      try { if (new URL(u).origin === origin) urls.push(u); } catch {}
    }
  }
  return urls;
}

// ──────────────────────────────────────────────────────────────────────
// Path-bucket sampling. When a single discovery source (typically the
// sitemap) returns more URLs than there is budget for, round-robin across
// first-path-segment buckets so every section of the site is represented
// rather than exhausting the crawl on /blog/ while /services/ and
// /products/ get zero coverage.
//
// Example: sitemap has 3,000 URLs under /news/, 40 under /schemes/, 12
// under /contact/, budget = 20. Without sampling: 20 news URLs. With
// sampling: ~7 news, ~7 schemes, ~6 contact. Same total, but now the
// auditor sees every section's template.
// ──────────────────────────────────────────────────────────────────────

export function sampleByPathBucket(urls, cap) {
  if (!Array.isArray(urls) || urls.length <= cap) return urls.slice();
  const buckets = new Map();
  for (const u of urls) {
    let key;
    try {
      const parsed = new URL(u);
      const parts = parsed.pathname.split("/").filter(Boolean);
      key = parts[0] || "/";
    } catch { key = "/"; }
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(u);
  }
  // Round-robin across buckets until the cap is reached.
  const out = [];
  const cursors = new Map();
  const keys = [...buckets.keys()];
  // Sort buckets so larger sections aren't starved if the cap doesn't
  // divide evenly — larger buckets pick first each round.
  keys.sort((a, b) => buckets.get(b).length - buckets.get(a).length);
  let progress = true;
  while (out.length < cap && progress) {
    progress = false;
    for (const k of keys) {
      if (out.length >= cap) break;
      const list = buckets.get(k);
      const i = cursors.get(k) || 0;
      if (i < list.length) {
        out.push(list[i]);
        cursors.set(k, i + 1);
        progress = true;
      }
    }
  }
  return out;
}

// ──────────────────────────────────────────────────────────────────────
// Nav-surfaced in-page seeding + click-reveal pass.
// Ships as a function reference to chrome.scripting.executeScript —
// MUST be self-contained (no closures over module scope).
// ──────────────────────────────────────────────────────────────────────

// navSurfacedCollect is serialised by chrome.scripting.executeScript({ func })
// via Function.prototype.toString(). It MUST be self-contained — no references
// to module scope, no imports, no outer closures.
//
// opts.noScroll (v0.2.1) — when true, skip every pass that would move the
// user's viewport: scrollAll(), expandRevealers(), advanceCarousels(). Used
// from seedDiscovery() on the seed tab (which IS the user's visible tab),
// so the "Scan" button doesn't visibly scroll the page up and down. Hidden
// worker tabs (chrome.tabs.create({active:false})) run with noScroll=false,
// so lazy-loaded nav / carousels / expanders are still discovered there.
export async function navSurfacedCollect(opts = {}) {
  const noScroll = !!(opts && opts.noScroll);
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  try {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  } catch {}

  const NAV_SEL = 'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-label*="navigation" i], [aria-label*="menu" i], .nav, .navbar, .menu, .header, .footer';
  // Link-candidate selector. v11 additions:
  //   • svg a  — SVG anchors use the namespaced `xlink:href` / `href` attribute
  //     rather than the HTML `href` attribute. `a[href]` misses them.
  //   • [onclick] — elements with an inline click handler; we don't call the
  //     handler, we regex-scrape the attribute string for URL literals later.
  const LINK_SEL = 'a[href], a[*|href], svg a, area[href], [data-href], [data-url], [data-to], [data-path], [role="link"], [onclick]';
  const EXPANDER_SEL = [
    '[aria-expanded="false"]',
    'button[aria-haspopup="true"]',
    'button[data-toggle]',
    'button[data-bs-toggle]',
    '[class*="menu-toggle" i]',
    '[class*="mega-menu" i] button',
    '[class*="dropdown-toggle" i]',
    '[class*="load-more" i]',
    '[class*="show-more" i]',
    '[class*="view-more" i]',
    '[class*="read-more" i]',
    '[class*="pagination" i] button',
    // Tabs: only click the non-selected ones. A selected tab is already the
    // active panel — clicking it would fire unnecessary click handlers with
    // no reveal benefit.
    '[role="tab"][aria-selected="false"]',
    '[role="tab"]:not([aria-selected])',
    'summary'
  ].join(",");
  // Carousel-next selectors — clicked separately from EXPANDER_SEL with their
  // own cap and settle time, because each click advances one slide and slides
  // typically render 300-500ms after the click (not immediate).
  const CAROUSEL_NEXT_SEL = [
    '[aria-label*="next" i][class*="slide" i]',
    '[aria-label*="next slide" i]',
    '[class*="slick-next" i]',
    '[class*="swiper-button-next" i]',
    '[class*="carousel-control-next" i]',
    '[class*="owl-next" i]',
    '[class*="glide__arrow--right" i]',
    'button[data-slide="next"]',
    'button[data-bs-slide="next"]'
  ].join(",");
  const HOVER_SEL = 'nav [aria-haspopup], nav [class*="mega" i], nav li[class*="has-submenu" i]';

  // ── Shadow-DOM-aware traversal ──────────────────────────────────
  // querySelectorAll stops at shadow boundaries — sites like SFDC Lightning,
  // Stencil, Lit, Polymer will under-report. These walk open shadow roots too.
  // Closed shadow roots remain invisible (spec-correct); nothing we can do.
  const SHADOW_WALK_CAP = 20000; // hard safety cap on elements visited
  function queryAllDeep(selector, root) {
    const out = [];
    let visited = 0;
    (function walk(node) {
      if (!node || visited > SHADOW_WALK_CAP) return;
      if (typeof node.querySelectorAll === "function") {
        try { for (const el of node.querySelectorAll(selector)) out.push(el); } catch {}
        const candidates = node.querySelectorAll("*");
        for (const el of candidates) {
          visited++;
          if (visited > SHADOW_WALK_CAP) return;
          if (el.shadowRoot) walk(el.shadowRoot);
        }
      }
    })(root || document);
    return out;
  }

  // Traverse up the tree across shadow-root boundaries via .host
  function deepParent(node) {
    if (!node) return null;
    if (node.parentElement) return node.parentElement;
    const root = node.getRootNode && node.getRootNode();
    if (root && root !== document && root.host) return root.host;
    return null;
  }

  async function waitStable(timeoutMs = 10000, minCount = 1) {
    let prev = -1, stableFor = 0;
    const start = Date.now();
    while (Date.now() - start < timeoutMs) {
      const count = queryAllDeep(LINK_SEL).length;
      if (count === prev) {
        stableFor += 300;
        if (count >= minCount && stableFor >= 600) break;
      } else { prev = count; stableFor = 0; }
      await sleep(300);
    }
  }

  // Exhaustive scroll: wall-clock-bounded rather than iteration-bounded.
  // Default 45 s budget per page (reasonable for infinite-scroll feeds,
  // paginated archives, virtualised lists). Breaks early when height has
  // been stable for 3 consecutive polls AND link count has also stabilised.
  async function scrollAll({ maxMs = 45000, maxIters = 600, stableStreak = 3 } = {}) {
    const doc = document.documentElement;
    const originY = window.scrollY;
    const start = Date.now();
    let lastHeight = -1, lastLinks = -1;
    let stable = 0;
    let iter = 0;

    while (iter < maxIters && Date.now() - start < maxMs) {
      const h = Math.max(doc.scrollHeight, document.body?.scrollHeight || 0);
      const links = queryAllDeep(LINK_SEL).length;
      if (h === lastHeight && links === lastLinks) {
        stable++;
        if (stable >= stableStreak) break;
      } else {
        stable = 0;
        lastHeight = h;
        lastLinks = links;
      }
      window.scrollTo(0, h);
      // Dispatch scroll on window + document for listeners that hook either.
      try { window.dispatchEvent(new Event("scroll")); } catch {}
      // Nested scrollers (light + shadow DOM) — find fresh each iter since
      // infinite-scroll feeds mount/unmount nodes.
      const scrollables = queryAllDeep("*").filter(el => {
        if (!(el instanceof HTMLElement)) return false;
        let s;
        try { s = getComputedStyle(el); } catch { return false; }
        return (s.overflowY === "auto" || s.overflowY === "scroll") &&
               el.scrollHeight > el.clientHeight + 50;
      });
      for (const el of scrollables) {
        try { el.scrollTop = el.scrollHeight; } catch {}
      }
      await sleep(300);
      iter++;
    }
    window.scrollTo(0, originY);
    await sleep(150);
  }

  async function expandRevealers() {
    const clicked = new WeakSet();
    const targets = queryAllDeep(EXPANDER_SEL).slice(0, 160);
    for (const el of targets) {
      if (clicked.has(el)) continue;
      clicked.add(el);
      try {
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.click();
        await sleep(140);
      } catch {}
    }
    // Hover menus (mega-menu style) — also deep-scanned for web-component navs
    const hoverTargets = queryAllDeep(HOVER_SEL).slice(0, 60);
    for (const el of hoverTargets) {
      try {
        el.dispatchEvent(new MouseEvent("mouseenter", { bubbles: true }));
        el.dispatchEvent(new MouseEvent("mouseover", { bubbles: true }));
        await sleep(100);
      } catch {}
    }
  }

  // Carousel next-arrows. Clicking a next-arrow typically advances one slide
  // at a time, so we click each arrow repeatedly until either we've clicked
  // MAX_SLIDES times total across the page, or the same arrow has been
  // clicked MAX_PER_ARROW times (many carousels loop, so we don't need
  // infinite clicks — ~10 slides captures the majority of real-world decks).
  async function advanceCarousels() {
    const arrows = queryAllDeep(CAROUSEL_NEXT_SEL).slice(0, 8);
    const MAX_PER_ARROW = 10;
    const MAX_SLIDES = 40;
    let total = 0;
    for (const arrow of arrows) {
      for (let i = 0; i < MAX_PER_ARROW && total < MAX_SLIDES; i++) {
        try {
          arrow.scrollIntoView({ block: "center", behavior: "instant" });
          if (arrow.disabled || arrow.getAttribute("aria-disabled") === "true") break;
          arrow.click();
          total++;
          // Slides render async — give each click time to mount the next DOM.
          await sleep(400);
        } catch { break; }
      }
    }
  }

  // ── CMS-aware settling (v12) ────────────────────────────────────────
  // First-paint-to-hydration timing varies by 3-4x between static
  // server-rendered CMS (WordPress, Drupal, Shopify) and SPA frameworks
  // (Next.js, Nuxt, Gatsby). A single "one-size-fits-all" settle budget
  // either wastes 10s on a static page that was ready at DOMContentLoaded
  // OR extracts links from a half-hydrated SPA before the router mounts
  // the route's link component. Detecting the stack at page-load time
  // and tuning the four waitStable windows fixes both cases.
  //
  // Detection inputs (in priority order):
  //   1. SPA framework data-script signatures (__NEXT_DATA__,
  //      __NUXT_DATA__, ___gatsby). These are unambiguous.
  //   2. <meta name="generator"> content. Covers WordPress, Drupal,
  //      Joomla, Shopify, Webflow, Ghost.
  //   3. Script-src patterns (_next/, _nuxt/) as fallbacks when the
  //      data-script tag was server-stripped.
  //   4. Empty-shell detector — single <div id="root"> / id="app" with
  //      no children — signals unhydrated SPA even without framework
  //      markers.
  function detectCMS() {
    try {
      // 1. Framework data-script tags
      if (document.querySelector('script#__NEXT_DATA__')) return "nextjs";
      if (document.querySelector('script#__NUXT_DATA__')) return "nuxt";
      if (document.querySelector('div#___gatsby')) return "gatsby";
      // 2. Generator meta
      const gen = (document.querySelector('meta[name="generator"]') || {}).content || "";
      if (/wordpress/i.test(gen)) return "wordpress";
      if (/drupal/i.test(gen)) return "drupal";
      if (/joomla/i.test(gen)) return "joomla";
      if (/webflow/i.test(gen)) return "webflow";
      if (/ghost/i.test(gen)) return "ghost";
      if (/shopify/i.test(gen)) return "shopify";
      if (/hugo/i.test(gen)) return "hugo";
      if (/eleventy/i.test(gen)) return "eleventy";
      // 3. Script-src patterns
      if (document.querySelector('script[src*="_next/"]')) return "nextjs";
      if (document.querySelector('script[src*="_nuxt/"]')) return "nuxt";
      // 4. Empty-shell detector (unhydrated SPA)
      const root = document.querySelector('#root, #app, #__next, #__nuxt');
      if (root && root.children.length === 0) return "spa";
    } catch {}
    return "unknown";
  }
  // Returns {initial, expander, scroll, carousel} ms for the four
  // waitStable windows. SPA presets ~2x defaults; static-CMS presets
  // ~0.6x defaults.
  function getSettlePreset(cms) {
    switch (cms) {
      case "nextjs":
      case "nuxt":
      case "gatsby":
      case "spa":
        return { initial: 15000, expander: 6000, scroll: 5000, carousel: 5000 };
      case "wordpress":
      case "drupal":
      case "joomla":
      case "shopify":
      case "webflow":
      case "ghost":
      case "hugo":
      case "eleventy":
        return { initial: 5000, expander: 2500, scroll: 2000, carousel: 2000 };
      default:
        return { initial: 8000, expander: 4000, scroll: 3000, carousel: 3000 };
    }
  }
  const detectedCms = detectCMS();
  const settle = getSettlePreset(detectedCms);
  try { console.log(`[EU] CMS ${detectedCms} — settle: ${JSON.stringify(settle)}`); } catch {}

  await waitStable(settle.initial);
  if (!noScroll) {
    // Viewport-moving passes. Gated off when this runs on the user's visible
    // seed tab so the scan doesn't visibly scroll the page. Static-DOM nav
    // links are still harvested below; lazy-loaded nav menus on the seed tab
    // are covered by sitemap / hreflang / feed discovery sources.
    await expandRevealers();
    await waitStable(settle.expander);
    await scrollAll();
    // Second expander pass — scroll often surfaces nav toggles that weren't
    // in the DOM on first paint (sticky headers, footer widgets that mount late).
    await expandRevealers();
    await waitStable(settle.scroll);
    // Carousel pass runs last because (a) carousels are typically inside
    // already-scrolled-into-view sections, and (b) advancing a carousel can
    // mount new DOM that we want `waitStable` to see before extraction.
    await advanceCarousels();
    await waitStable(settle.carousel);
  } else {
    try { console.log(`[EU] navSurfacedCollect — noScroll mode (static-DOM only)`); } catch {}
  }

  const loc = location;
  // PDF is intentionally absent — we DO want to enqueue PDF links. Other
  // binary/asset extensions are filtered here (cheap in-page skip) and
  // also at the queue level (authoritative).
  const ASSET_RX = /\.(js|mjs|css|png|jpg|jpeg|gif|svg|ico|webp|webm|avif|woff2?|ttf|eot|otf|mp4|mp3|wav|json|xml|txt|map|zip|gz|br|xls|xlsx|doc|docx|ppt|pptx|csv|rtf|exe|dmg|msi|apk)$/i;
  // Admin / machine endpoints — skipped before priority scoring to avoid
  // wasting a link slot on URLs the queue would reject anyway.
  const SKIP_PREFIX = [
    "/_next/", "/_nuxt/", "/__nextjs", "/static/", "/assets/", "/api/", "/cdn-cgi/",
    "/wp-admin/", "/wp-json/", "/wp-login.php", "/xmlrpc.php", "/wp-cron.php"
  ];

  function withinNav(el) {
    let cur = el;
    let hops = 0;
    while (cur && cur !== document.body && hops < 200) {
      if (cur.matches && typeof cur.matches === "function") {
        try { if (cur.matches(NAV_SEL)) return true; } catch {}
      }
      cur = deepParent(cur);
      hops++;
    }
    return false;
  }

  // Skip links that a sighted keyboard/mouse user would NOT be able to
  // discover while browsing. Author-declared hidden:
  //   • `hidden` attribute
  //   • `aria-hidden="true"` subtree
  //   • `inert` subtree
  //   • `aria-disabled="true"` on the link itself
  //
  // Intentionally NOT filtering on computed `display:none` / `visibility:hidden`:
  // those frequently flag pre-interaction states (closed dropdowns, collapsed
  // mega-menus, tab panels) that the scroll + expandRevealers pass is meant
  // to surface. Filtering by computed style would reintroduce the exact
  // under-discovery problem the expand/hover pass was built to fix.
  function isAuthorHidden(el) {
    let cur = el;
    let hops = 0;
    while (cur && hops < 200) {
      if (cur.nodeType === 1) {
        if (cur.hasAttribute && cur.hasAttribute("hidden")) return true;
        if (cur.getAttribute && cur.getAttribute("aria-hidden") === "true") return true;
        if (cur.hasAttribute && cur.hasAttribute("inert")) return true;
        if (cur === el && cur.getAttribute && cur.getAttribute("aria-disabled") === "true") return true;
      }
      cur = deepParent(cur);
      hops++;
    }
    return false;
  }

  function scoreFor(el, href) {
    let s = 0;
    if (withinNav(el)) s += 10;
    try {
      const u = new URL(href, loc.href);
      const depth = u.pathname.split("/").filter(Boolean).length;
      if (depth <= 1) s += 3;
      else if (depth <= 2) s += 2;
      else if (depth <= 3) s += 1;
    } catch {}
    return s;
  }

  const byUrl = new Map();

  // ── Hash-router detection (v12) ─────────────────────────────────────
  // SPAs built on old Angular (pre-$locationProvider HTML5 mode), Ember
  // `locationType: 'hash'`, Vue Router `mode: 'hash'`, and older React
  // Router use "#/path" URL fragments as the route. Every anchor on the
  // page has `href="#/something"`. Without detection, our standard
  // `u.hash = ""` canonicalization strips the fragment and collapses
  // every route to the homepage — a silent, invisible under-discovery
  // failure mode.
  //
  // Detection rule: sample all <a href> anchors on the current page. If
  // ≥30% start with "#/" AND we have at least 10 anchors to sample, the
  // page is using hash-routing. Conversion rule: when hash-routing is
  // detected, "#/foo/bar" is treated as "/foo/bar" before URL resolution,
  // and the hash strip applies to the already-converted URL.
  //
  // 10-anchor floor prevents false positives on a nearly-empty homepage
  // where two fragment links ("#top", "#skip-to-content") would otherwise
  // be >30% of a sample of 5. 30% is set low enough to catch sites that
  // mix hash routes with a few real hrefs, high enough to not trigger on
  // jump-link-heavy documentation pages.
  let hashRouterDetected = null; // null = unmeasured, true/false = measured
  function isHashRouted() {
    if (hashRouterDetected !== null) return hashRouterDetected;
    const anchors = queryAllDeep("a[href]");
    let hashPath = 0, total = 0;
    for (const a of anchors) {
      const h = a.getAttribute && a.getAttribute("href");
      if (!h) continue;
      total++;
      if (h.startsWith("#/")) hashPath++;
    }
    if (total < 10) { hashRouterDetected = false; return false; }
    hashRouterDetected = (hashPath / total) >= 0.30;
    if (hashRouterDetected) {
      try { console.log(`[EU] hash-router detected (${hashPath}/${total} anchors hash-rooted)`); } catch {}
    }
    return hashRouterDetected;
  }

  // Scheme-less external-domain detector. Catches hrefs like
  //   "linkedin.com/in/foo"  or  "twitter.com/user"
  // that are NOT schemed and NOT leading-slash rooted. If we fed those to
  // `new URL(raw, loc.href)` the browser treats them as relative and
  // produces garbage like `https://yournest.in/team/linkedin.com/in/foo`.
  // Strategy: if the raw href has no scheme, no leading slash, and starts
  // with a dotted hostname-looking segment, either reject it (external)
  // or re-parse it as `https://` + raw and then same-hostname-filter.
  const BARE_DOMAIN_RX = /^(?:[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}(?:[/?#].*)?$/i;
  function tryAdd(raw, el) {
    if (!raw || typeof raw !== "string") return;
    raw = raw.trim();
    // Hash-router conversion (see isHashRouted() comment). "#/foo/bar"
    // → "/foo/bar" when the page is hash-routed; non-hash-routed pages
    // still strip "#anything" as an in-page fragment (not a route).
    if (raw.startsWith("#/") && isHashRouted()) {
      raw = raw.slice(1); // "#/foo" → "/foo"
    }
    if (!raw || raw.startsWith("#") || raw.startsWith("javascript:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) return;
    // Reject scheme-less bare-domain hrefs before new URL() mis-resolves them
    // as a relative path under the current page. If it parses as an absolute
    // URL against just `https://`, and the resulting hostname is different
    // from loc.hostname, treat as external and drop.
    if (!/^https?:\/\//i.test(raw) && !raw.startsWith("/") && BARE_DOMAIN_RX.test(raw)) {
      try {
        const probe = new URL("https://" + raw);
        if (probe.hostname !== loc.hostname) return;
        raw = probe.toString(); // same-hostname: keep the schemed form
      } catch { return; }
    }
    try {
      const u = new URL(raw, loc.href);
      if (u.protocol !== "http:" && u.protocol !== "https:") return;
      if (u.hostname !== loc.hostname) return;
      if (SKIP_PREFIX.some(pre => u.pathname.startsWith(pre))) return;
      if (ASSET_RX.test(u.pathname)) return;
      u.hash = "";
      const s = u.toString();
      if (s === loc.href) return;
      const priority = el ? scoreFor(el, s) : 0;
      // v0.4.4 — capture the anchor text (or aria-label) alongside the
      // priority so the broken-link report can show WHICH link is dead.
      let text = "";
      if (el) {
        try {
          text = (el.getAttribute && el.getAttribute("aria-label")) || el.textContent || "";
          text = text.trim().replace(/\s+/g, " ").slice(0, 120);
        } catch {}
      }
      const prior = byUrl.get(s);
      if (!prior || prior.priority < priority) {
        byUrl.set(s, { priority, text: text || (prior && prior.text) || "" });
      } else if (prior && !prior.text && text) {
        prior.text = text;
      }
    } catch {}
  }

  // Modal / dialog trigger detector. `data-href` (Bootstrap), `data-url`,
  // `data-to`, `data-path`, and `role="link"` are frequently hung off
  // BUTTONs that open a modal dialog — "View details", "Open contact
  // form", "Watch video", etc. Those trigger elements are NOT navigation;
  // the URL in `data-href` may be an AJAX endpoint returning a JSON
  // snippet, or it may be a real page URL duplicated from a nearby <a>.
  // Either way, a normal browsing human does not arrive at those URLs
  // by clicking the trigger — they get a dialog, not a page change.
  //
  // Heuristic: skip extracting the data-* attribute if the element is,
  // or is wrapped in:
  //   • <button> (the classic modal-open trigger)
  //   • role="button"
  //   • aria-haspopup="dialog" / "menu" / "listbox" / "true"
  //   • data-toggle="modal" (Bootstrap 4) / data-bs-toggle="modal" (BS5)
  //
  // Real <a href="…"> links ARE still honoured even inside a button
  // wrapper — we only skip the data-* attributes. The href attribute is
  // never a modal trigger.
  function isModalTrigger(el) {
    let cur = el;
    let hops = 0;
    while (cur && cur !== document.body && hops < 30) {
      if (cur.nodeType === 1) {
        const tag = (cur.tagName || "").toLowerCase();
        if (tag === "button") return true;
        const role = cur.getAttribute && cur.getAttribute("role");
        if (role === "button") return true;
        const hasPopup = cur.getAttribute && cur.getAttribute("aria-haspopup");
        if (hasPopup && hasPopup !== "false") return true;
        const toggle = cur.getAttribute && (
          cur.getAttribute("data-toggle") ||
          cur.getAttribute("data-bs-toggle")
        );
        if (toggle && /modal|dialog|popover|offcanvas/i.test(toggle)) return true;
      }
      cur = deepParent(cur);
      hops++;
    }
    return false;
  }

  // Inline-handler URL scraper. Matches explicit navigation intent inside
  // attribute strings — exactly the patterns that appear on image-as-link
  // handlers and click-to-navigate cards:
  //   onclick="location.href='/foo'"
  //   onclick="window.location='/foo'"
  //   onclick="location.assign('/foo')"
  //   onclick="window.open('/foo')"
  //   onclick="router.push('/foo')"          ← Vue Router / Next.js
  //   onclick="navigate('/foo')"             ← React Router useNavigate
  //   onclick="history.pushState(…, '/foo')"
  // Only matches clean "/path" or schemed URL string literals — we never
  // evaluate the handler, so we can't follow hrefs built dynamically from
  // string concatenation.
  const HANDLER_ATTRS = ["onclick", "onmousedown", "onmouseup", "onkeydown", "onkeyup", "onkeypress"];
  const NAV_CALL_RX = /(?:location\.(?:href|pathname)\s*=|location\.assign\s*\(|location\.replace\s*\(|window\.open\s*\(|router\.push\s*\(|router\.replace\s*\(|navigate\s*\(|history\.push(?:State)?\s*\(\s*[^,]*,\s*[^,]*,)\s*['"`]([^'"`]+)['"`]/g;
  function extractHandlerUrls(str, el) {
    if (!str || str.length > 4000) return; // pathological inline handlers capped
    for (const m of str.matchAll(NAV_CALL_RX)) {
      const url = m[1];
      if (!url) continue;
      // Only accept leading-slash paths or schemed URLs — reject bare words,
      // fragment-only, and JS-variable-constructed URLs.
      if (url.startsWith("/") || /^https?:\/\//i.test(url)) tryAdd(url, el);
    }
  }

  for (const el of queryAllDeep(LINK_SEL)) {
    if (isAuthorHidden(el)) continue;

    // SVG anchors use xlink:href (SVG 1.1) or a plain href (SVG 2). The HTML
    // `href` property on SVGAElement is actually an SVGAnimatedString, not a
    // plain string — always read the attribute form.
    const isSvgAnchor = el.namespaceURI === "http://www.w3.org/2000/svg" && (el.tagName || "").toLowerCase() === "a";
    if (isSvgAnchor) {
      const svgHref = el.getAttributeNS("http://www.w3.org/1999/xlink", "href") || el.getAttribute("xlink:href") || el.getAttribute("href");
      if (svgHref) { tryAdd(svgHref, el); continue; }
    }

    // Always honour an explicit href — that's an actual <a> link regardless
    // of wrapper context.
    const hrefAttr = el.getAttribute("href");
    if (hrefAttr) { tryAdd(hrefAttr, el); continue; }

    // Inline handlers — scraped before the modal-trigger skip because a
    // handler on a <button> that calls location.href='/foo' IS a real
    // navigation, whereas the button's data-href (which usually targets a
    // modal payload) still gets skipped by the modal check below.
    for (const attr of HANDLER_ATTRS) {
      const handler = el.getAttribute(attr);
      if (handler) extractHandlerUrls(handler, el);
    }

    // data-* attributes: only treat as nav if the element isn't a modal
    // trigger. Filters out "View details" buttons, "Watch video" popups,
    // etc. whose `data-href` is a dialog payload rather than a page URL.
    if (isModalTrigger(el)) continue;
    const href =
      el.getAttribute("data-href") ||
      el.getAttribute("data-url") ||
      el.getAttribute("data-to") ||
      el.getAttribute("data-path");
    tryAdd(href, el);
  }

  // JSON blobs — Next/Nuxt/Apollo/Redux dumps often contain route paths.
  const PATH_RX = /"(\/[A-Za-z0-9_\-\/.]{1,200})"/g;
  const JSON_SEL = 'script[type="application/json"], script#__NEXT_DATA__, script#__NUXT_DATA__, script[data-n-data], script[id*="APOLLO"], script[id*="INITIAL_STATE" i]';
  for (const script of queryAllDeep(JSON_SEL)) {
    const text = script.textContent || "";
    if (!text || text.length > 2_000_000) continue;
    for (const m of text.matchAll(PATH_RX)) tryAdd(m[1]);
  }

  // Inline <script> bodies (non-JSON). SPA navigation is frequently buried
  // inside event handlers attached in code — we can't follow runtime
  // navigation, but we can regex-match the same literal navigation calls
  // the inline-handler scraper does. Strict URL-literal matching only; no
  // fuzzy path-pattern extraction (that produced too many phantoms in
  // testing — `"/api/v1/…"` paths, React routing internals, etc.).
  // Cap script bodies at 500KB each to avoid regex hangs on bundled app
  // chunks.
  const SCRIPT_MAX_BYTES = 500_000;
  const INLINE_SCRIPT_SEL = "script:not([src]):not([type='application/json']):not([type*='ld+json'])";
  for (const script of queryAllDeep(INLINE_SCRIPT_SEL)) {
    const text = script.textContent || "";
    if (!text || text.length > SCRIPT_MAX_BYTES) continue;
    // Skip scripts that are JSON blobs by content (some sites embed huge
    // state dumps in a plain <script> without a type attribute).
    const trimmed = text.slice(0, 200).trim();
    if (trimmed.startsWith("{") || trimmed.startsWith("[")) continue;
    for (const m of text.matchAll(NAV_CALL_RX)) {
      const url = m[1];
      if (!url) continue;
      if (url.startsWith("/") || /^https?:\/\//i.test(url)) tryAdd(url);
    }
  }

  const out = [...byUrl.entries()]
    .sort((a, b) => b[1].priority - a[1].priority)
    .map(([url, v]) => ({ url, priority: v.priority, text: v.text || "" }));
  return out;
}
