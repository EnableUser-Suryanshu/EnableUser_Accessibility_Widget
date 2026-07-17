# EnableUser Accessibility Widget

A small Chrome (Manifest V3) extension that audits web pages against **WCAG 2.1 AA** using **axe-core**.

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
