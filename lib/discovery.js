// Out-of-band URL discovery sources. All cheap (no tab), HEAD/GET only.
// Ported from SiteScope Phase 0: sitemap deep walk (depth 5), robots.txt
// Sitemap directives, hreflang alternates, common-path probe.
//
// The in-page "nav-first seeding" + click-reveal helpers live here too; they
// run via chrome.scripting.executeScript in the target tab.

import { canonicalize } from "./request-queue.js";

const SITEMAP_WALK_DEPTH = 5;
const SITEMAP_MAX_FILES = 200;
const COMMON_PATHS = [
  "/", "/about", "/about-us", "/contact", "/contact-us", "/team", "/leadership",
  "/careers", "/jobs", "/services", "/solutions", "/products", "/pricing",
  "/blog", "/news", "/press", "/resources", "/support", "/help", "/faq",
  "/docs", "/documentation", "/api", "/developers", "/login", "/sign-in",
  "/signup", "/register", "/privacy", "/privacy-policy", "/terms", "/legal",
  "/cookies", "/accessibility", "/sitemap", "/search", "/locations", "/partners"
];

// ──────────────────────────────────────────────────────────────────────
// Sitemap / robots.txt discovery
// ──────────────────────────────────────────────────────────────────────

export async function discoverSeedsFromOrigin(origin) {
  const candidates = new Set([
    `${origin}/sitemap.xml`,
    `${origin}/sitemap_index.xml`,
    `${origin}/wp-sitemap.xml`,
    `${origin}/sitemap-index.xml`
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
  let fileCount = 0;
  for (const sm of candidates) {
    await walkSitemap(sm, origin, visited, found, 0, () => fileCount++ > SITEMAP_MAX_FILES);
  }
  return [...found];
}

async function walkSitemap(sitemapUrl, origin, visited, found, depth, overBudget) {
  if (depth > SITEMAP_WALK_DEPTH || visited.has(sitemapUrl) || overBudget()) return;
  visited.add(sitemapUrl);
  let text;
  try {
    const res = await fetch(sitemapUrl, { credentials: "omit", cache: "no-store" });
    if (!res.ok) return;
    text = await res.text();
  } catch { return; }

  const isIndex = /<sitemapindex[\s>]/i.test(text);
  const locs = [...text.matchAll(/<loc>\s*([^<]+?)\s*<\/loc>/gi)].map(m => m[1]);

  if (isIndex) {
    for (const loc of locs) {
      if (overBudget()) return;
      try {
        const u = new URL(loc);
        if (u.origin === origin) await walkSitemap(u.toString(), origin, visited, found, depth + 1, overBudget);
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
// hreflang alternates — pulled from the homepage HTML, cheap
// ──────────────────────────────────────────────────────────────────────

export async function discoverHreflang(homepageUrl) {
  let html;
  try {
    const res = await fetch(homepageUrl, { credentials: "omit", cache: "no-store" });
    if (!res.ok) return [];
    html = await res.text();
  } catch { return []; }
  const out = new Set();
  const rx = /<link[^>]+rel=["']alternate["'][^>]*hreflang=["'][^"']+["'][^>]*>/gi;
  for (const tag of html.match(rx) || []) {
    const m = tag.match(/href=["']([^"']+)["']/i);
    if (!m) continue;
    const u = canonicalize(m[1], homepageUrl);
    if (u) out.add(u);
  }
  return [...out];
}

// ──────────────────────────────────────────────────────────────────────
// Common-path probing: HEAD-check ~40 well-known paths; enqueue if OK
// ──────────────────────────────────────────────────────────────────────

export async function probeCommonPaths(origin, { concurrency = 10 } = {}) {
  const found = [];
  const queue = COMMON_PATHS.slice();
  const workers = [];
  const worker = async () => {
    while (queue.length) {
      const p = queue.shift();
      const url = `${origin}${p}`;
      try {
        // HEAD first; some servers 405 HEAD, fall through to a tiny GET
        let res = await fetch(url, { method: "HEAD", credentials: "omit", cache: "no-store", redirect: "follow" });
        if (res.status === 405 || res.status === 501) {
          res = await fetch(url, { method: "GET", credentials: "omit", cache: "no-store", redirect: "follow" });
        }
        if (res.ok || (res.status >= 300 && res.status < 400)) found.push(res.url || url);
      } catch {}
    }
  };
  for (let i = 0; i < concurrency; i++) workers.push(worker());
  await Promise.all(workers);
  return [...new Set(found)];
}

// ──────────────────────────────────────────────────────────────────────
// Nav-surfaced in-page seeding + click-reveal pass.
// Ships as a function reference to chrome.scripting.executeScript —
// MUST be self-contained (no closures over module scope).
// ──────────────────────────────────────────────────────────────────────

// navSurfacedCollect is serialised by chrome.scripting.executeScript({ func })
// via Function.prototype.toString(). It MUST be self-contained — no references
// to module scope, no imports, no outer closures.
export async function navSurfacedCollect() {
  const sleep = ms => new Promise(r => setTimeout(r, ms));

  try {
    Object.defineProperty(document, "visibilityState", { value: "visible", configurable: true });
    Object.defineProperty(document, "hidden", { value: false, configurable: true });
    document.dispatchEvent(new Event("visibilitychange"));
  } catch {}

  const NAV_SEL = 'nav, header, footer, [role="navigation"], [role="banner"], [role="contentinfo"], [aria-label*="navigation" i], [aria-label*="menu" i], .nav, .navbar, .menu, .header, .footer';
  const LINK_SEL = 'a[href], area[href], [data-href], [data-url], [data-to], [data-path], [role="link"]';
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
    'summary'
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
    const targets = queryAllDeep(EXPANDER_SEL).slice(0, 120);
    for (const el of targets) {
      if (clicked.has(el)) continue;
      clicked.add(el);
      try {
        el.scrollIntoView({ block: "center", behavior: "instant" });
        el.click();
        await sleep(120);
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

  await waitStable(8000);
  await expandRevealers();
  await waitStable(4000);
  await scrollAll();
  // Second expander pass — scroll often surfaces nav toggles that weren't
  // in the DOM on first paint (sticky headers, footer widgets that mount late).
  await expandRevealers();
  await waitStable(3000);

  const loc = location;
  const ASSET_RX = /\.(js|mjs|css|png|jpg|jpeg|gif|svg|ico|webp|webm|avif|woff2?|ttf|eot|otf|mp4|mp3|wav|pdf|json|xml|txt|map|zip|gz|br)$/i;
  const SKIP_PREFIX = ["/_next/", "/_nuxt/", "/__nextjs", "/static/", "/assets/", "/api/", "/cdn-cgi/"];

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
  function tryAdd(raw, el) {
    if (!raw || typeof raw !== "string") return;
    raw = raw.trim();
    if (!raw || raw.startsWith("#") || raw.startsWith("javascript:") || raw.startsWith("mailto:") || raw.startsWith("tel:")) return;
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
      const prior = byUrl.get(s);
      if (!prior || prior < priority) byUrl.set(s, priority);
    } catch {}
  }

  for (const el of queryAllDeep(LINK_SEL)) {
    const href =
      el.getAttribute("href") ||
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

  const out = [...byUrl.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([url, priority]) => ({ url, priority }));
  return out;
}
