# EnableUser Accessibility Widget

A small Chrome (Manifest V3) extension that audits web pages against **WCAG 2.1 AA** using **axe-core**.

## v0.5.0 — screenshots end to end (and one codebase again)

Two builds both called themselves v0.4.9: one added screenshot support, the other
fixed paste-a-list concurrency and a batch of reporting work. Neither descended
from the other. v0.5.0 is the unification — see [DIVERGENCE.md](DIVERGENCE.md)
for the full inventory and what was deliberately left behind.

**Screenshots now work from capture through to deliverable.**

- **Report viewer** gains a Screenshots gallery and a Screenshot column in
  Violations showing each offending element highlighted in place. Images load
  lazily via `IntersectionObserver` — full-page PNGs run 1–3 MB, so a 200-page
  crawl would otherwise push ~400 MB of base64 into the tab on open. Resolution
  is storage-first, falling back to a message to the service worker.
- **Excel** carries previews in three places: inline on each Violations row (the
  sheet auditors actually work in), on the Pages sheet, and on the dedicated
  Issue Screenshots sheet, which adds Impact / Success Criteria context. The
  **classic-report** workbook now carries them too — it
  previously embedded no images at all, so exporting via "Open Classic Report"
  silently dropped every screenshot the crawl had captured.
- **Lazy-loaded content is now captured.** Before each capture the page is
  walked top to bottom in viewport-sized steps, then returned to where it
  started; we then wait for images to settle (bounded at 4 s).
  `captureBeyondViewport` reaches below-the-fold content but never triggers its
  lazy loading, so long pages used to capture blank hero images. Layout is left
  exactly as the page renders — an earlier attempt resized the viewport to the
  document height instead, which redefined `vh` and stretched every
  viewport-sized hero (a 3456px test page became 21328px).
- **Element crops are legible.** The highlight is drawn as an overlay box rather
  than only an inline outline, because an outline is clipped by any ancestor with
  `overflow: hidden` — precisely the containers that cause layout bugs. Crops
  centre on the element and expand to a 400×300 minimum so a checkbox arrives
  with context, and the original scroll position is restored afterwards.
- **Single-page scans capture screenshots too.** Previously only the inventory
  crawl did, so "Scan this page" produced findings with nothing to show a
  stakeholder. This runs against your own visible tab, hence the scroll restore.
- Screenshots referenced but no longer in storage now say so, instead of
  rendering as a blank grey rectangle.

**No more silent truncation.** Every cap that quietly dropped findings is gone:
per-rule node caps (was 25), links analysed for 1.4.1 (was 300), the hover-cue
sample (100), boundary-contrast controls (150), the text-spacing sample (600),
motion candidates (10), and Excel embedded previews (300). A truncated audit used
to render identically to a complete one — the client fixed 25 issues, re-scanned,
and 25 more appeared. Element screenshots keep a bound because each costs a real
debugger round trip, but it is now a 45s per-page budget rather than a count of
30, and exhausting it is logged instead of passing silently. `DEFAULT_MAX_URLS`
also disagreed between `background.js` (50) and the popup (500); all three
sources now say 500, pinned by `test/limits.test.mjs`.

Also in v0.5.0:

- **Paste-a-list concurrency fixed.** The global cap was 200 — harmless on
  single-origin crawls, where the 8-per-origin cap bound them, but on a
  multi-domain paste list nothing held total tabs down. Pasting ~200 URLs opened
  ~200 background tabs, collapsed Chrome's renderer/network pool, and reported
  perfectly reachable links as unreachable. Global cap is now **10**;
  single-origin crawls are unchanged at 8.
- **WCAG 1.4.1 over-reporting fixed.** Link-in-text-block analysis now skips
  nav / header / footer / breadcrumb / pagination chrome, and stays silent when
  no stylesheet is readable (cross-origin CSS) rather than flagging every
  colour-only link on the page.
- **Per-page outcome** (Clean / Issues / Unreachable) with a summary tile row, in
  both the classic report and the inventory.
- **Reproject a crawl into the classic report** with no rescan — the inventory
  already holds the full axe payload.
- **Release notes moved to [CHANGELOG.md](CHANGELOG.md).** They had been living
  in the `manifest.json` `description` field, which had grown to ~6300
  characters; Chrome documents a 132-character limit there and enforces it at
  Web Store submission.
- `test/viewer-harness/` — headless-Chrome harness for the report viewer, since
  Chrome 137+ blocks `--load-extension` and the extension's own
  `chrome.debugger` calls conflict with any external CDP driver.
- `test/xlsx-drawings.test.mjs` — builds real workbooks in Node and asserts the
  OOXML image plumbing, where an off-by-one silently points a preview at the
  wrong screenshot rather than failing loudly. Run with
  `node test/xlsx-drawings.test.mjs`.

## v0.4.8 — reports persist (no more "Report expired")

Multi-page and single-page reports were held only in the service worker's memory; Chrome evicts an idle MV3 worker after ~30 s, after which the report tab showed "expired" and downloads failed. Reports now persist to chrome.storage.local (last 5 kept, older pruned) and are re-warmed on demand — the report tab, Excel, and CSV work indefinitely, across browser restarts. Viewer, Excel, and CSV all read the same persisted object, so what you see in the run result is exactly what lands in the Excel.

Also in v0.4.8:

- **Default recipe slimmed to axe-core only**: media checks, PDF/Office audit, visual-state checks, overlay dismissal, and audit-both are now all **opt-in (default OFF)**. First-run defaults: axe ✓, real pages only ✓, broken-link detector ✓ — everything else unticked. Saved preferences migrate once to the new recipe, then whatever you tick wins as usual.
- **Overlay dismissal upgraded** (when enabled): the dismisser now pierces open shadow roots, so shadow-DOM CMPs (Usercentrics-style) can be clicked instead of just hidden; Google Funding Choices selectors added; and accept/close button matching understands Hindi labels (स्वीकार करें, सहमत, ठीक है, बंद करें, …) for Indian-language sites.

## v0.4.6 — visual-state checks (automating part of the manual checklist)

New check suite (`lib/visual-checks.js`, popup toggle, default ON) that automates the machine-detectable subset of the Manual Test Checklist:

- **`eu-link-color-only`** (Violation, 1.4.1) — every link inside a text block is route-classified: if it has no grayscale-surviving cue (underline, border, bold, italic, lightness-differing background) AND its colour differs from the surrounding text by less than 3:1, that's a provable Use-of-Colour failure. Assists checklist **C-02 / C-03**.
- **`eu-link-route-b-states`** (Incomplete/review, 1.4.1) — colour-only links that pass 3:1 but have no `:hover`/`:focus` cue rule anywhere in the page CSS. Route B (G183) requires both. Flagged for confirmation because JS-applied styles are invisible to a CSSOM scan. Assists **C-04**.
- **`eu-focus-suppressed`** (Violation, 2.4.7) — detects the classic `*:focus { outline: none }` reset with **no** compensating `:focus`/`:focus-visible` indicator anywhere in the CSS. If replacements exist elsewhere, emits `eu-focus-outline-review` (Incomplete) instead. Assists **K-02**.
- **`eu-link-no-hover-feedback`** (Incomplete/advisory, best-practice) — links with no hover rule at all. Explicitly labelled "not a WCAG AA defect — do not raise" per the team's over-reporting guidance; hover is optional, focus is mandatory.

The **Manual Checklist sheet** gains a **"Machine assist"** column tying K-02/C-02/C-03/C-04 to these rule ids: review the pre-screened findings first, then spot-check. `:visited` contrast remains fully manual (browsers block reading it — force the state in DevTools).

Also ships **`CRAWL-PIPELINE.md`** — the plain-language "what actually runs" walkthrough of every crawl stage with the real constants.

## v0.4.5 — manual-test layer + scan transparency + default recipe

- **Manual Checklist sheet** in every `report.xlsx` / `inventory.xlsx`: the team's Manual Test Checklist v1.2 (129 cases, 9 passes — keyboard-only, forms & errors, zoom/reflow, colour & non-text contrast, motion/timing/media, screen reader, content & copy, pointer & mobile, cross-page). These are the SCs automated scanners are weak at (keyboard traps, focus indicators, hover/focus/visited link states, form errors, moving content, modal traps). Each case carries an **"Applies To"** column scoped by what the crawler actually found — form tests list the pages with forms, carousel tests the pages with carousels, video tests the pages with video (with sample URLs) — so the team tests where it matters instead of everywhere. Result/Notes columns are blank for the auditor to fill. Data lives in `lib/manual-checklist.js`; regenerate it from the xlsx when the checklist version bumps.
- **Scan Settings sheet**: every workbook now records exactly what configuration produced it — profile, axe tags, every check on/off, settle timing, concurrency, extension version. No more guessing what a report ran with.
- **Default recipe preset** (first-run defaults): axe ✓, media ✓, PDF/Office ✓, dismiss overlays ✓, audit both ✓, **real pages only ✓**, broken-link detector ✓, screenshots ✗. Click Multi Page Scan / Scope with zero checkbox fiddling.
- **Settle minimum 1s** (was 5s): the 2s DOM-quiet requirement remains the effective floor, so static pages audit ~2s after load; dynamic pages still get up to 10s.

## v0.4.4 — internal broken-link (404) detector

Runs automatically after every Multi Page / Inventory crawl (popup checkbox to disable). Three detection layers, all executed with your session cookies so results match what a real visitor sees:

1. **Hard errors** — every unique internal link target harvested from every crawled page (including sitemap/feed/CMS-sourced URLs the crawl budget never reached) is status-checked: HEAD first, GET fallback where HEAD is refused. 404/410 → hard-404, 5xx → server-error, timeouts/DNS failures → unreachable, other 4xx → client-error, 401/403 → access-blocked (informational).
2. **Soft 404s** — before checking, two deliberately-nonexistent URLs are probed to fingerprint the site's real not-found behaviour. If the site answers 200 with a "not found" page, its text signature (word shingles) is captured and every 200-status link target's body is compared against it (≥80% similar → soft-404). A title/H1 wording heuristic ("404", "page not found", …) catches the rest.
3. **Dead redirects** — links that 30x-redirect to the homepage (the classic silently-deleted page) are flagged even though they end at HTTP 200.
4. **Rendered-DOM layer (SPA-safe)** — raw fetch can't see not-found pages that JavaScript renders after a 200 app-shell response. At crawl start, a worker tab renders a nonexistent URL and fingerprints the site's *rendered* not-found page (main content only — header/footer/nav stripped so shared page chrome can't false-positive). Every crawled page's rendered DOM is then compared against that fingerprint, plus a rendered title/heading wording check. Verdicts are folded into the same Broken Links sheet as `soft-404 (rendered)`.

Findings land in a **Broken Links** sheet in both `report.xlsx` and `inventory.xlsx`: broken URL, problem type, detail, HTTP status, redirect target, and — because the crawler records the link graph — **every page that links to the broken URL plus the anchor text used**, so you can fix the actual `<a>` tags. Checks run ~16 at a time with a 15 s per-URL timeout, capped at 8,000 targets (cap noted in the sheet when hit). New file: `lib/link-check.js`.

## v0.4.3 — findings-first fast path + SiteCrawler ports

- **Screenshots are now opt-in** (popup checkbox, default off). Full-page + per-violation capture via the debugger API was the heaviest per-page cost after axe; with it off you get findings + Excel only, making large-site crawls practical. Turn the checkbox on when you need the visual evidence.
- **Dedicated minimized crawler window** — worker tabs open in a separate minimized window instead of flooding your tab strip. Falls back to normal tabs if the window can't be created or you close it mid-crawl.
- **Circuit breaker** — 20 consecutive page failures (site down, auth wall, network drop) stops the crawl instead of grinding through the whole queue. The report's meta records `stopReason`.
- **Crash recovery** — the crawl checkpoints its accumulated pages (minus screenshots) to `chrome.storage.local` every 20 URLs. If the browser or service worker dies mid-crawl, the popup shows a **Recover interrupted crawl** button that rebuilds the inventory report from the checkpoint.
- **"Real pages only" discovery mode** (popup checkbox, default off) — SiteCrawler-style crawling: follow only links that actually appear on pages (nav + body anchors); skip sitemap.xml, robots.txt sitemaps, RSS/Atom feeds, and CMS API probes. Use it when sitemap/feed sources drag junk URLs into the report. Default (off) keeps the full discovery pipeline.

## v0.4.2

Adaptive page-settle wait before axe-core runs (ported from SiteCrawler v1.1.0). Every page waits at least **5 s** after load (cookie banners, JS redirects), then the audit starts as soon as the DOM has been quiet for **2 s**, capped at **10 s** for endlessly-mutating pages. Replaces the fixed 15 s sleep from v0.4.1 — typical pages now audit in roughly a third of the time. Constants: `SETTLE_MIN_MS` / `SETTLE_QUIET_MS` / `SETTLE_MAX_MS` in `background.js`.

Two modes:

- **Scan Current Page** — runs axe on the active tab and opens a report tab with results + CSV download.
- **Multi Page Scan** — extracts up to 30 same-domain links from the current page, opens them in batches of 5 tabs, runs axe in each, closes the tab, aggregates everything, and opens a single report tab.

## Setup

```bash
npm install
```

The `postinstall` hook copies `node_modules/axe-core/axe.min.js` → `lib/axe.min.js`. Verify that file exists.

## Load in Chrome

1. Open `chrome://extensions`
2. Toggle **Developer mode** on
3. Click **Load unpacked** → select this folder
4. Pin the extension from the toolbar

## Usage

1. Navigate to any public page.
2. Click the extension icon.
3. Click **Scan** on either row.
4. On first use for a domain, Chrome prompts for host permission — allow it.
5. A new tab opens with the full accessibility report. Click **Download CSV** to save.

## Project layout

```
manifest.json                MV3 manifest
background.js                Orchestrator: inject axe, manage tabs, build reports
content-script.js            Runs axe inside each page, reports back
lib/axe.min.js               Vendored axe-core 4.x (built by build.js)
lib/csv-writer.js            RFC 4180 CSV helper
lib/wcag-tags.js             WCAG 2.1 A/AA criterion map
popup/                       Toolbar popup UI
report/                      Report page opened in a new tab
build.js                     Vendors axe-core into lib/
```

## Notes

- In-memory state only — closing the browser loses unsaved reports.
- Multi-page scan uses 5 concurrent tabs with a 45 s per-tab timeout.
- Report displays WCAG 2.1 A/AA criterion pass/fail summary + all issue instances with selector + HTML snippet.
