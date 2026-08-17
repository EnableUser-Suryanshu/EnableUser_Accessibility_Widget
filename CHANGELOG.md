# Changelog

Moved here from the `manifest.json` `description` field, which had grown to
~6300 characters. Chrome documents a 132-character limit on that field and
enforces it at Web Store submission, so it cannot carry release notes.

For the reasoning behind the v0.5.0 unification — including what was taken
from each of the two v0.4.9 builds and what was deliberately left behind —
see [DIVERGENCE.md](DIVERGENCE.md).

## What the extension does

Scan a single page or crawl same-site links (configurable max URLs and crawl depth) against WCAG 2.1 AA, IS 17802 (Ch 7 / 9 / 10 / 12 / 13), EN 301 549, Section 508, and ADA Title III using axe-core plus India-specific and IS 17802 site-governance checks. Audits linked PDF and Office (docx/xlsx/pptx) documents for structural accessibility. Classifies crawled pages by URL-template shape and DOM simhash (Hamming-distance clustering). Produces a CSV report, scope docx, component inventory, and one-click copy/download of the auditable-URL list.

## Unreleased (workflow-mode branch)

Workflow Analyzer — record-as-you-browse scanning, mechanism mirrored from the
forensic digest of axe DevTools 4.131.2 (User Flow Analysis) and BrowserStack
Accessibility Toolkit 8.25 (see `_Workroom/2026-08-17_extension-mechanism-digest`
for the evidence). Start recording from the popup, browse the journey (login,
forms, checkout), stop for a timeline report. Hard navigations are caught by
`tabs.onUpdated status:"complete"` (no webNavigation — both vendors proved it
unnecessary); SPA/state changes by a body MutationObserver with BrowserStack's
`attributeFilter:["class"]` config, self-overlay filtering, and hierarchical
mutation fingerprints so repeated churn (carousels, tickers) never re-triggers.
Scans are paced by a suppressing 1 s debounce with an in-flight lock plus one
trailing re-check. The session model is pages[] (normalized-URL identity,
query/hash stripped) + steps[] ("Full page scan" / "State change detected" /
"Clicked") with the step-reuse rule — a continuous burst of DOM changes
collapses into one step. Issues are deduplicated session-wide by
hash(node html + selector + rule id + page URL), so a violation re-found on a
later scan counts once; repeats are reported as suppressed-duplicate counts.
Sessions checkpoint to chrome.storage per step (service-worker-eviction safe),
cap at 200 steps, and produce the standard report plus a new "Workflow" Excel
sheet (per-step timeline with new-issue counts). New files: lib/workflow.js
(session model, 19-invariant test in test/workflow.test.mjs),
lib/workflow-observer.js (injected observer). Scan execution reuses
scanInExistingTab under the shared-operation guard, so workflow scans cannot
race a crawl's ACTIVE_* config.

Also on this branch:

Critical fix, found by live end-to-end testing: Chrome silently no-ops a
second chrome.scripting.executeScript({files}) of the same file into the
same document+world — verified on Chrome 152 (the call resolves in 0 ms,
the script never runs). Any SECOND scan of the same document therefore hung
until the 60 s timeout — latent since v0.4.x (the crawler opens a fresh tab
per URL so it never re-scans a document; workflow mode re-scans constantly
and exposed it, and it also broke a repeated popup 'Scan current page' on
the same page). Fix: content-script.js now wires a persistent EU_RESCAN
listener on first injection and guards re-entry; runContentScan messages
first and injects the file only when no listener answers (fresh document).
Verified live: second scan 60 s hang → 1 s; full workflow session on
zerodha.com: 2 pages, 2 steps, 93 unique issues, report + evidence bundle.

DevTools panel — `devtools/` registers an "EnableUser" panel
(chrome.devtools.panels.create, inspected tabId passed via query string, the
BrowserStack pattern) with a live workflow surface: Start/Stop, recording
pulse, stat tiles (pages / steps / scans / unique issues / repeats
suppressed), and a reverse-chronological step timeline polling
WORKFLOW_DETAIL every 1.5 s. Dark theme, no chrome.devtools APIs beyond
panel creation — the background stays the single source of truth.

AI evidence capture + local Claude review (the vendors' server-AI layer,
done locally) — once per step the rendered DOM (≤1.5 MB) and accessible CSS
(≤300 KB) are serialized and stored (≤40 snapshots/session); on Stop an
`enableuser-workflow-ai-bundle-<testId>.json` downloads next to the report:
timeline + every needs-review (incomplete) finding + evidence.
`tools/ai-review/prepare.mjs` splits it into per-case prompts with the DOM
excerpt around each flagged node; Claude writes strict JSON verdicts;
`tools/ai-review/merge.mjs` buckets them — confirmed (tagged EU-ai, only at
or above the 0.7 confidence threshold), dismissed, human review queue.
Verdicts never override engine results; they settle only what the engines
marked incomplete. Pipeline contract pinned by test/ai-review.test.mjs.

## v0.5.0

unifies two independently-developed v0.4.9 builds. Screenshots are now end-to-end: full-page captures plus one highlighted, cropped shot per violating element, embedded in the Excel (inline Preview column on the Violations sheet, on the Pages sheet, and a dedicated Issue Screenshots sheet) and rendered lazily in the report viewer (gallery section plus a Screenshot column, IntersectionObserver-backed so a 200-page crawl does not push hundreds of MB of base64 into the tab up front). Before capturing, the layout viewport is expanded to the full document height so lazy-loaded content below the fold actually renders: captureBeyondViewport reaches that content but never fires its IntersectionObservers, so long pages previously captured blank hero images. Width is left exactly as the tab had it, so evidence never crosses a responsive breakpoint the user was not at. Element captures highlight via an overlay box (an outline alone is clipped by any ancestor with overflow:hidden), crop to a 400x300 minimum so small targets carry legible context, and restore the original scroll position. Single-page scans capture screenshots too, and they run against your own visible tab. Paste-a-list no longer opens every pasted URL at once: the global concurrency cap was 200, harmless on single-origin crawls (the 8-per-origin cap bound them) but on a multi-domain paste list nothing held total tabs down, so ~200 URLs opened ~200 background tabs, collapsed the Chrome renderer pool, and made reachable links fail as unreachable. Global cap is now 10; single-origin behaviour is unchanged. Cookie/consent dismissal pierces open shadow roots (Usercentrics-style CMPs render entirely inside one) and recognises Hindi accept/close labels. WCAG 1.4.1 link analysis now skips nav/header/footer/breadcrumb chrome and stays silent when no stylesheet is readable, instead of flagging every navigation link on every page. Reports and the inventory carry a per-page outcome (Clean / Issues / Unreachable) with a summary tile row, and a completed crawl inventory can be reprojected into the classic criterion-table report with no rescan. Default recipe is axe-core only; media, PDF/Office, visual-state checks, overlay dismissal and audit-both are opt-in.

## v0.4.8

reports no longer expire — multi-page and single-page reports are persisted to chrome.storage.local (last 5 kept, pruned automatically), so the report tab and Excel/CSV downloads survive service-worker eviction and browser restarts; viewer, Excel, and CSV are all generated from the same persisted report object, so the run result and every export always match.

## v0.4.7

visual-checks tranche 2 — control/button boundary contrast (1.4.11), declared focus-ring colours vs page background (1.4.11), provable ::placeholder contrast (1.4.3), aria-invalid-on-load (3.3.1), positive tabindex (2.4.3), focus-stolen-on-load (3.2.1), adjacent duplicate image+text links (2.4.4), text-spacing survival with injected 1.4.12 overrides, and a 2.5s motion-sampling pass that flags auto-moving regions with no pause control (2.2.2) plus missing prefers-reduced-motion CSS. Manual Checklist 'Machine assist' column now marks 17 assisted cases and 14 cases already covered by axe-core/media-checks — 31 of 129 with automated coverage.

## v0.4.6

visual-state check suite automates the machine-detectable subset of the manual checklist — colour-only links in text blocks (WCAG 1.4.1 Route A/B classification with computed 3:1 link-vs-text contrast), focus-outline suppression detection (2.4.7 — the *:focus{outline:none} reset), CSSOM scan for hover/focus cue rules on Route B links, and a no-hover-feedback UX advisory; provable failures land in Violations, pseudo-state findings in Incomplete tagged 'review' (never over-claimed). Manual Checklist sheet gains a 'Machine assist' column linking assisted cases (K-02, C-02, C-03, C-04) to their new eu-* rule ids. Ships CRAWL-PIPELINE.md — a plain-language walkthrough of exactly what runs at each crawl stage.

## v0.4.5

embedded Manual Test Checklist v1.2 (129 cases across 9 passes covering the SCs scanners can't automate — keyboard traps, focus indicators, form errors, hover/focus/visited link states, moving content, modal traps) emitted as a 'Manual Checklist' Excel sheet scoped per-page by the components the crawler found; new 'Scan Settings' sheet echoes the exact configuration that produced each report; default recipe preset (axe + media + PDF + dismiss overlays + audit-both + real-pages discovery + broken-link detector); settle minimum lowered to 1s (adaptive 1–10s, 2s DOM-quiet floor).

## v0.4.4

internal broken-link detector — status-checks every internal link target found during the crawl (hard 404/410, 5xx, unreachable), fingerprints the site's real not-found behaviour with nonexistent-URL probes to catch soft 404s (200-status 'page not found' pages, matched by title wording and body similarity), flags links that silently redirect to the homepage, adds an SPA-safe rendered-DOM layer (a worker tab renders a nonexistent URL to fingerprint the site's JavaScript-rendered not-found page, then every crawled page's rendered DOM is compared against it), and reports each broken URL with the pages that link to it and the anchor text used (new 'Broken Links' Excel sheet).

## v0.4.3

screenshots now opt-in (findings + Excel fast path by default), worker tabs open in a dedicated minimized window, circuit breaker stops dead-site crawls after 20 consecutive failures, mid-crawl checkpoints every 20 pages with one-click crash recovery, and a 'real pages only' discovery mode (follow visible links only — skip sitemap/feeds/CMS probes).

## v0.4.2

adaptive page-settle wait (5s min, ends after 2s of DOM quiet, 10s cap) before axe-core runs — replaces the fixed 15s sleep.
