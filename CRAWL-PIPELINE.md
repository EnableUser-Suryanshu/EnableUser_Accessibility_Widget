# EnableUser Crawl Pipeline — what actually runs (v0.4.6)

A plain-language walkthrough of a Multi Page / Inventory scan, in execution
order, with the real constants. Cross-check any report against its
**Scan Settings** sheet — that sheet is written from the live configuration
at scan time, so it is always the truth for that specific run.

## 0. You click Scan

The popup reads the checkboxes, saves them as your new defaults, and sends the
scan message to the background service worker. Default recipe (first run):
axe ✓ · media ✗ · PDF/Office ✗ · visual-states ✗ · dismiss overlays ✗ ·
audit both ✗ · real pages only ✓ · broken-link detector ✓ · screenshots ✗.

## 1. Seed scan (your current tab)

Your open tab is audited first, in place — no new tab, so your session,
cookies, and scroll position are untouched. Full check stack (see step 5).
The seed's URL is marked "settled" so no worker re-scans it.

## 2. Discovery + rendered-404 probe (parallel)

Two things happen at once:

- **Discovery.** With **Real pages only ON** (default): only the seed page's
  rendered navigation and body links are harvested — nothing else. With it
  OFF: sitemap.xml (recursive), robots.txt sitemap lines, homepage `<link>`
  rels (hreflang/canonical/next/prev), RSS/Atom feeds, and CMS APIs
  (WordPress REST, Shopify, Next.js/Gatsby manifests, JSON-LD) are also
  probed, and their URLs enter the queue at lower priority than real links
  (nav 8 > link-rel 7 > CMS 6 > hreflang 5 > feed 4 > sitemap 3 > body 2).
- **Rendered-404 probe.** A worker tab opens a guaranteed-nonexistent URL on
  the site, lets it fully render, and fingerprints the rendered not-found
  page (title + main-content signature). This baseline powers the SPA-safe
  soft-404 layer in step 5.

Every discovered link also enters the **link graph** (target → which pages
link to it + anchor text) for the broken-link check in step 7.

## 3. The queue

- Same-hostname scope. Depth unbounded by default; **Max URLs** is the cap.
- Junk filters: /wp-admin, /wp-login, /cdn-cgi, /captcha, asset extensions,
  archive paths (/tag, /category, /feed, /amp, /print), and tracking params
  are stripped/blocked before anything is queued.
- Dedup happens at four layers: canonical URL at enqueue → post-redirect
  settled-URL → rendered-content hash → cross-folder same-slug collapse.

## 4. The worker pool

- Up to **200 tabs globally**, max **8 per origin** (rate limiter also backs
  off on 429/503 and honours Retry-After).
- Worker tabs open in a **dedicated minimized window** — not your tab strip.
- Per tab: load (60 s timeout) → **adaptive settle**: minimum 1 s, proceeds
  after 2 s of DOM quiet, hard cap 10 s → late-redirect poll → dedup check.
- A worker that exceeds 150 s total is force-abandoned so the pool moves on.
- **Circuit breaker**: 20 consecutive page failures stop the crawl (the
  report's stopReason records it).
- **Checkpoint**: accumulated results are persisted every 20 pages; if the
  browser dies mid-crawl, the popup offers "Recover interrupted crawl".

## 5. Per-page audit (inside each tab)

In order:
1. Overlay dismissal (cookie/consent/modal) if enabled (default OFF).
2. **axe-core 4.12.1** with the profile's WCAG tag set (2.0/2.1/2.2 A/AA).
3. **Audit both** (default OFF): a second axe pass so both the overlay-present
   and overlay-dismissed states are covered. The extra pass only runs on pages
   where an overlay was actually dismissed — plain pages get a single pass.
4. Custom suites, all merged into the same violations/incomplete stream:
   - **india-checks** (if enabled): script/lang mismatches, RTL, per-passage lang.
   - **media-checks**: video captions/autoplay, audio transcripts, embed titles,
     document-link quality + full media inventory.
   - **is17802-checks** (if enabled): accessibility statement, feedback, relay.
   - **visual-checks** (v0.4.6): colour-only links vs 3:1 (1.4.1 Route A/B),
     focus-outline suppression (2.4.7), hover/focus cue presence in CSSOM.
     Provable failures → Violations; pseudo-state findings → Incomplete
     (tagged "review") — never over-claimed.
5. Content signals: forms, tables, modals, carousels, video/audio, iframes,
   headings, images/alt, SPA markers, shadow DOM → feeds the component
   inventory and the Manual Checklist "Applies To" scoping.
6. Rendered-DOM soft-404 check against the step-2 baseline.
7. Template fingerprint (URL cluster + DOM simhash) for clustering.
8. Screenshot — only if the screenshots checkbox is ON. Three steps:
   a. The layout viewport is expanded to the full document height (width left
      alone, so responsive breakpoints don't shift). This fires every
      `IntersectionObserver` on the page, which is what makes lazy-loaded
      images below the fold actually load. Skipped when the page already fits.
   b. Wait until every `<img>` reports `complete`, capped at 4 s — otherwise the
      capture freezes lazy images mid-fetch as blank placeholders.
   c. One full-page PNG, then one cropped + highlighted PNG per distinct
      violating element (max 30 per page, 400×300 minimum crop so small targets
      keep context). The viewport override is cleared before detaching.
9. Links harvested for the queue (and the link graph), tab closed.

## 6. PDF / Office audits (after the crawl)

Every discovered PDF is byte-scanned (tagged? struct tree? /Lang? /Title?);
every docx/xlsx/pptx is zip-parsed (title, language, headings/sheets/slides).
4 parallel, 12–15 s timeout each. No rendering, no uploads — everything local.

## 7. Broken-link detection (four layers)

1. Every unique link-graph target is status-checked (HEAD → GET fallback,
   your cookies, 16 concurrent, 15 s timeout, 8 000-target cap — the sheet
   says so if capped): hard 404/410, 5xx, unreachable, 4xx, access-blocked.
2. Two nonexistent-URL fetch probes classify the site's not-found behaviour
   (proper status / redirect-home / soft-200) and fingerprint soft-404 bodies.
3. Redirect-to-home targets are flagged as probable deleted pages.
4. The per-page rendered-DOM verdicts from step 5 are folded in (SPA-safe).

Each finding carries the linking pages + anchor text, so the team can fix
the actual `<a>` tags.

## 8. Report assembly

In-memory aggregation → report tab opens immediately. Excel workbooks are
generated lazily on first download click. Sheets include: Overview,
Violations / Passes / Incomplete / Inapplicable, Pages, Templates, Clusters,
Proposed Sample, Form Fields, Components, Test Matrix, Media & Documents,
**Broken Links**, **Manual Checklist** (129 cases, "Applies To" scoped
per page, machine-assist column), **Scan Settings** (the config echo),
Scan Environment. Plus scope.docx.

## Known limits (by design)

- `:visited` link contrast cannot be automated (browser privacy blocks it) —
  Manual Checklist C-pass covers it; force the state in DevTools.
- Hover/focus findings from CSSOM are advisory: styles applied by JavaScript
  event handlers are invisible to the scan, so those land in Incomplete for
  human confirmation, never as hard violations.
- Cross-origin stylesheets can't be read; visual-checks silently skips them.
- The link-status fetch layer uses your cookies but is not a rendered
  browser; sites that hard-block non-navigation requests may show
  `access-blocked` rows — the rendered-DOM layer still covers crawled pages.
