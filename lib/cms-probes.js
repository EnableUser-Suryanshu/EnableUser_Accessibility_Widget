// CMS / framework URL-discovery probes. Each probe takes a site origin (and
// optionally the seed HTML or homepage URL) and returns an array of URLs it
// discovered via structured APIs rather than anchor crawling. Probes run in
// parallel from seedDiscovery() and fail silently on any error — they're
// additive signals, never gating.
//
// Design principles:
//   • Same-origin only. Return absolute URLs on the same origin as the seed.
//   • Cheap HTTP-only. No tab creation, no JS execution. Fetches return
//     quickly or short-circuit.
//   • Same-shape return. Every probe returns a flat string[] of URLs. The
//     caller tags them with a source label when enqueuing.
//   • Conservative pagination. Cap per-probe at a few hundred pages
//     fetched to avoid runaway loops on misconfigured endpoints.
//   • Graceful detection. Missing endpoints / wrong CMS → empty array, no
//     throws. We try every probe on every site and keep whatever hits.

import { canonicalize } from "./request-queue.js";

const DEFAULT_TIMEOUT_MS = 12000;
const MAX_PAGINATION_PAGES = 50;   // hard ceiling per endpoint
const MAX_URLS_PER_PROBE = 5000;   // safety ceiling, higher than most sites ship

// ──────────────────────────────────────────────────────────────────────
// Fetch helper with timeout — probes MUST NOT block discovery forever.
// ──────────────────────────────────────────────────────────────────────

async function fetchWithTimeout(url, opts = {}, timeoutMs = DEFAULT_TIMEOUT_MS) {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(url, {
      credentials: "omit",
      cache: "no-store",
      signal: ctrl.signal,
      ...opts
    });
  } finally {
    clearTimeout(t);
  }
}

// Origin-guard — only keep URLs on the same origin as the seed. Probes pull
// back absolute URLs from remote JSON; we can't trust them blindly.
function sameOrigin(urlStr, origin) {
  try { return new URL(urlStr).origin === origin; } catch { return false; }
}

// ──────────────────────────────────────────────────────────────────────
// WordPress REST API probe
//
// WordPress exposes every published post, page, and custom-post-type at
// predictable URLs under /wp-json/wp/v2/. A single authenticated-or-not GET
// to /wp-json/wp/v2/types enumerates every registered type, and from there
// we hit each type's endpoint with _fields=link to get only the URL field
// (dramatically smaller response than full post bodies).
//
// This catches pages that:
//   • are not in the sitemap (sitemap plugins sometimes exclude CPTs or
//     require manual regeneration after adding a post type)
//   • have noindex meta (legitimately reachable to a logged-in user but
//     excluded from sitemap.xml)
//   • are on sites where the anchor crawl never reaches that section
//     because the navigation is JS-gated
//
// Detection: try GET /wp-json/wp/v2/types. If 200 with a JSON body, it's
// WordPress. No meta-generator sniff — some WP sites strip the meta tag
// but leave the REST API on.
// ──────────────────────────────────────────────────────────────────────

export async function probeWordPress(origin) {
  if (!origin) return [];
  const urls = new Set();
  let types;
  try {
    const res = await fetchWithTimeout(`${origin}/wp-json/wp/v2/types`);
    if (!res.ok) return [];
    const ct = (res.headers.get("content-type") || "").toLowerCase();
    if (!ct.includes("json")) return [];
    types = await res.json();
  } catch { return []; }

  if (!types || typeof types !== "object") return [];

  // `types` maps typeSlug → { rest_base, rest_namespace, ... }. rest_base is
  // what goes into the URL (often the plural of the slug: "post" → "posts",
  // "event" → "events"). Some CPTs have custom rest_namespaces; stick to
  // wp/v2 to avoid auth-protected private endpoints.
  const endpoints = [];
  for (const key of Object.keys(types)) {
    const t = types[key] || {};
    const base = t.rest_base || t.slug || key;
    const ns = t.rest_namespace || "wp/v2";
    // Built-in types we DO want: post, page, and any public CPT.
    // Built-in types we DON'T want: attachment (media files, not pages),
    // wp_block (reusable Gutenberg blocks), nav_menu_item.
    if (["attachment", "wp_block", "nav_menu_item", "wp_template", "wp_template_part", "wp_global_styles", "wp_navigation"].includes(key)) continue;
    if (ns !== "wp/v2") continue;
    endpoints.push(`${origin}/wp-json/${ns}/${base}`);
  }

  // Paginate each endpoint with _fields=link to minimise response size.
  // WordPress exposes X-WP-Total and X-WP-TotalPages headers — if either is
  // missing we bail after the first under-full page.
  for (const endpoint of endpoints) {
    if (urls.size >= MAX_URLS_PER_PROBE) break;
    for (let page = 1; page <= MAX_PAGINATION_PAGES; page++) {
      if (urls.size >= MAX_URLS_PER_PROBE) break;
      let batch;
      try {
        const res = await fetchWithTimeout(
          `${endpoint}?per_page=100&page=${page}&_fields=link&status=publish`
        );
        if (!res.ok) break;
        batch = await res.json();
      } catch { break; }
      if (!Array.isArray(batch) || batch.length === 0) break;
      for (const item of batch) {
        const u = canonicalize(item?.link || "", origin);
        if (u && sameOrigin(u, origin)) urls.add(u);
      }
      if (batch.length < 100) break;   // final page reached
    }
  }
  return [...urls];
}

// ──────────────────────────────────────────────────────────────────────
// Shopify products + collections probe
//
// Shopify ships two JSON endpoints that list every public product and
// collection respectively — /products.json and /collections.json. Both are
// paginated via ?page=N and both return empty arrays when exhausted.
// ──────────────────────────────────────────────────────────────────────

export async function probeShopify(origin) {
  if (!origin) return [];
  const urls = new Set();

  async function walk(endpoint, pathFor) {
    for (let page = 1; page <= MAX_PAGINATION_PAGES; page++) {
      if (urls.size >= MAX_URLS_PER_PROBE) break;
      let data;
      try {
        const res = await fetchWithTimeout(`${endpoint}?page=${page}&limit=250`);
        if (!res.ok) break;
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        if (!ct.includes("json")) break;
        data = await res.json();
      } catch { break; }
      const arr = data?.products || data?.collections || [];
      if (!Array.isArray(arr) || arr.length === 0) break;
      for (const item of arr) {
        const handle = item?.handle;
        if (!handle) continue;
        const u = canonicalize(`${origin}${pathFor(handle)}`, origin);
        if (u && sameOrigin(u, origin)) urls.add(u);
      }
      if (arr.length < 250) break;
    }
  }

  // /products.json returns { products: [...] }; /collections.json returns
  // { collections: [...] }. Only probe — if the first page 404s, Shopify
  // isn't running here and we silently drop the whole chain.
  let probeOk = false;
  try {
    const res = await fetchWithTimeout(`${origin}/products.json?page=1&limit=1`);
    probeOk = res.ok && (res.headers.get("content-type") || "").toLowerCase().includes("json");
  } catch {}
  if (!probeOk) return [];

  await walk(`${origin}/products.json`, h => `/products/${h}`);
  await walk(`${origin}/collections.json`, h => `/collections/${h}`);
  return [...urls];
}

// ──────────────────────────────────────────────────────────────────────
// HTML sitemap page probe
//
// Distinct from XML sitemaps: many marketing / corporate sites publish a
// human-readable "Sitemap" page that lists every section's URLs as plain
// <a> links. Sometimes this page is the ONLY place deep pages are linked
// from — especially on sites where the main nav is limited to 5-7 items.
//
// Probe paths (in order): /sitemap, /site-map, /sitemap.html, /site-map.html,
// /sitemap.htm, /site-map.htm. First 200 with text/html content wins; we
// extract every same-origin anchor href.
// ──────────────────────────────────────────────────────────────────────

const HTML_SITEMAP_PATHS = [
  "/sitemap",
  "/sitemap.html",
  "/sitemap.htm",
  "/site-map",
  "/site-map.html",
  "/site-map.htm",
  "/pages/sitemap",
  "/en/sitemap"
];
const ANCHOR_HREF_RX = /<a\b[^>]*\bhref\s*=\s*["']([^"']+)["'][^>]*>/gi;

export async function probeHtmlSitemap(origin) {
  if (!origin) return [];
  for (const path of HTML_SITEMAP_PATHS) {
    let html;
    try {
      const res = await fetchWithTimeout(`${origin}${path}`);
      if (!res.ok) continue;
      const ct = (res.headers.get("content-type") || "").toLowerCase();
      if (!ct.includes("html")) continue;
      html = await res.text();
    } catch { continue; }
    if (!html) continue;

    // Heuristic — a real HTML sitemap has lots of anchors. Marketing 404
    // pages on some sites return 200 with a generic shell; we reject
    // anything with fewer than 20 same-origin anchor hrefs to avoid
    // treating a not-found shell as a sitemap.
    const urls = new Set();
    for (const m of html.matchAll(ANCHOR_HREF_RX)) {
      const raw = m[1];
      if (!raw) continue;
      const u = canonicalize(raw, `${origin}${path}`);
      if (u && sameOrigin(u, origin)) urls.add(u);
    }
    if (urls.size < 20) continue;
    return [...urls];
  }
  return [];
}

// ──────────────────────────────────────────────────────────────────────
// Next.js / Gatsby build-manifest probe
//
// Next.js emits /_next/static/[buildId]/_buildManifest.js — a JS file that
// declares every statically-known route. We pull the buildId out of the
// homepage's __NEXT_DATA__ script (which was sent with the seed HTML),
// fetch the manifest, and regex-extract the route paths.
//
// Gatsby ships /page-data/app-data.json and /page-data/*/page-data.json —
// the app-data.json includes a webpackCompilationHash which we use to
// locate per-page JSON entries. This probe is best-effort; Gatsby sites
// vary wildly in whether they expose these paths publicly.
// ──────────────────────────────────────────────────────────────────────

export async function probeFrameworkManifest(origin, seedHtml) {
  if (!origin || !seedHtml || typeof seedHtml !== "string") return [];
  const urls = new Set();

  // Next.js build manifest path
  const nextDataMatch = seedHtml.match(/<script\b[^>]*\bid\s*=\s*["']__NEXT_DATA__["'][^>]*>([\s\S]*?)<\/script>/i);
  if (nextDataMatch && nextDataMatch[1]) {
    try {
      const data = JSON.parse(nextDataMatch[1]);
      const buildId = data?.buildId;
      if (buildId) {
        const manifestUrl = `${origin}/_next/static/${encodeURIComponent(buildId)}/_buildManifest.js`;
        try {
          const res = await fetchWithTimeout(manifestUrl);
          if (res.ok) {
            const body = await res.text();
            // _buildManifest.js sets self.__BUILD_MANIFEST = {...}. Pull out
            // every quoted route-looking string ("/about", "/blog/[slug]")
            // and drop the bracketed-template ones — those aren't navigable.
            for (const m of body.matchAll(/["']\/([A-Za-z0-9_\-\/.]*)["']/g)) {
              const p = m[1];
              if (!p) continue;
              if (p.includes("[")) continue;        // /[slug] template, not a real URL
              if (p.endsWith(".js") || p.endsWith(".css")) continue;
              const u = canonicalize(`/${p}`, origin);
              if (u && sameOrigin(u, origin)) urls.add(u);
            }
          }
        } catch {}
      }
      // Some Next.js sites also expose a pages-manifest server-side. Skip —
      // requires auth in production builds.
    } catch {}
  }

  // Gatsby — app-data.json contains an index of page-data chunks we can
  // reconstruct URLs from. The JSON format has varied across Gatsby versions
  // so we regex the JSON for path strings.
  if (/\b(?:___gatsby|window\.___webpackCompilationHash|page-data\/)\b/.test(seedHtml)) {
    try {
      const res = await fetchWithTimeout(`${origin}/page-data/app-data.json`);
      if (res.ok) {
        const text = await res.text();
        for (const m of text.matchAll(/"path"\s*:\s*"([^"]+)"/g)) {
          const p = m[1];
          if (!p) continue;
          const u = canonicalize(p, origin);
          if (u && sameOrigin(u, origin)) urls.add(u);
        }
      }
    } catch {}
  }

  return [...urls];
}

// ──────────────────────────────────────────────────────────────────────
// JSON-LD URL harvest
//
// Schema.org structured data is a goldmine of navigable URLs. Pages
// typically include the page's own canonical URL plus several related URLs:
//   • WebPage.url / WebPage.mainEntityOfPage
//   • BreadcrumbList.itemListElement[*].item.@id / .url
//   • ItemList.itemListElement[*].url
//   • Article.mentions[*].url
//   • @graph — some sites wrap their entire site model in one graph array
//
// Runs as a second-pass HTML parse. Unlike the PATH_RX regex in
// navSurfacedCollect, this walks the actual JSON tree so nested URLs in
// arrays and @graph wrappers are extracted reliably.
// ──────────────────────────────────────────────────────────────────────

export function extractJsonLdUrls(html, baseUrl) {
  if (!html || typeof html !== "string") return [];
  const origin = (() => { try { return new URL(baseUrl).origin; } catch { return null; } })();
  if (!origin) return [];
  const urls = new Set();

  const blocks = [];
  const scriptRx = /<script\b[^>]*\btype\s*=\s*["']application\/ld\+json["'][^>]*>([\s\S]*?)<\/script>/gi;
  for (const m of html.matchAll(scriptRx)) {
    const body = (m[1] || "").trim();
    if (body) blocks.push(body);
  }

  const URL_KEYS = new Set([
    "url", "@id", "mainEntityOfPage", "sameAs",
    "targetUrl", "identifier", "potentialAction"
  ]);

  function walk(node) {
    if (!node) return;
    if (typeof node === "string") {
      const u = canonicalize(node, baseUrl);
      if (u && sameOrigin(u, origin)) urls.add(u);
      return;
    }
    if (Array.isArray(node)) {
      for (const child of node) walk(child);
      return;
    }
    if (typeof node !== "object") return;
    for (const [k, v] of Object.entries(node)) {
      if (URL_KEYS.has(k)) {
        if (typeof v === "string") {
          const u = canonicalize(v, baseUrl);
          if (u && sameOrigin(u, origin)) urls.add(u);
        } else if (Array.isArray(v) || (v && typeof v === "object")) {
          walk(v);
        }
      } else if (Array.isArray(v) || (v && typeof v === "object")) {
        walk(v);
      }
    }
  }

  for (const block of blocks) {
    try {
      const parsed = JSON.parse(block);
      walk(parsed);
    } catch {
      // Some sites emit multiple JSON objects concatenated into one script
      // block (invalid but common). Try to recover by splitting on "}{"
      // boundaries.
      for (const chunk of block.split(/(?<=})\s*(?={)/)) {
        try { walk(JSON.parse(chunk)); } catch {}
      }
    }
  }

  return [...urls];
}

// ──────────────────────────────────────────────────────────────────────
// Master probe orchestrator. Runs every probe in parallel, returns per-source
// URL lists tagged for attribution. Callers merge into queue with the source
// label as the URL's discovery origin.
// ──────────────────────────────────────────────────────────────────────

export async function probeAllCmsApis(origin, seedUrl) {
  if (!origin) {
    return { wordpress: [], shopify: [], htmlSitemap: [], frameworkManifest: [], jsonLd: [] };
  }

  // Fetch the seed HTML once up front — probeFrameworkManifest needs it for
  // __NEXT_DATA__, and extractJsonLdUrls uses it directly. Sharing the one
  // fetch also halves the HTTP load on the seed URL.
  let seedHtml = "";
  if (seedUrl) {
    try {
      const res = await fetchWithTimeout(seedUrl);
      if (res.ok) {
        const ct = (res.headers.get("content-type") || "").toLowerCase();
        if (ct.includes("html")) seedHtml = await res.text();
      }
    } catch {}
  }

  const [wordpress, shopify, htmlSitemap, frameworkManifest, jsonLd] = await Promise.all([
    probeWordPress(origin).catch(() => []),
    probeShopify(origin).catch(() => []),
    probeHtmlSitemap(origin).catch(() => []),
    probeFrameworkManifest(origin, seedHtml).catch(() => []),
    Promise.resolve(seedHtml ? extractJsonLdUrls(seedHtml, seedUrl || origin) : [])
  ]);

  return { wordpress, shopify, htmlSitemap, frameworkManifest, jsonLd };
}
