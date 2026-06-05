# EnableUser Accessibility Widget

A small Chrome (Manifest V3) extension that audits web pages against **WCAG 2.1 AA** using **axe-core**.

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
