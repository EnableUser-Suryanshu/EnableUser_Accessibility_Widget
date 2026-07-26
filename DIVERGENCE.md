# Divergence: `main` vs the local working tree

Two independent versions of "v0.4.9" exist. Both `manifest.json` files claim
`"version": "0.4.9"`, but they describe different features and neither
descends from the other — they are siblings branched off the same v0.4.8.

| Branch | Commit | What its v0.4.9 is |
| --- | --- | --- |
| `main` | `6f3708a` | "screenshots implemented that persist in excel" |
| `local-0.4.9` | `5a0dcb3` | "paste-a-list … global cap lowered to 10" |
| `port-viewer-screenshots` | `a62934b` | `local-0.4.9` + main's viewer work + fixes |

`main` is what GitHub had. `local-0.4.9` is the tree that was being worked on
outside git (formerly the `EnableUser-v0.4.8/` folder, despite the name).
`port-viewer-screenshots` is the unification in progress and is the branch to
build on.

Git cannot three-way merge these: `main` has exactly one commit, so there is
no common ancestor recorded. Every comparison below was done by direct diff.

---

## Feature inventory

### Only in the local tree

| Area | Feature | Notes |
| --- | --- | --- |
| `background.js` | `CONCURRENT_TABS` 200 → 10 | The v0.4.9 headline. 200 was only reachable on multi-origin runs; a ~200-URL paste list opened ~200 tabs at once, collapsed Chrome's renderer pool, and surfaced reachable links as "URL not reachable". Single-origin crawls are unchanged — `PER_ORIGIN_TABS` (8) still binds them. `main` is still on 200. |
| `background.js` | `scanMulti` / `scanInNewTab` **removed** | Architectural. `main` runs two crawl engines: `scanInventory` and a separate `scanMulti` producing the classic report. The local tree unified on `scanInventory` and derives the classic report via `openClassicReport()` + `inventoryPagesToReportPages()`. One engine, no duplicated crawl semantics. |
| `background.js` | `openClassicReport()`, `inventoryPagesToReportPages()`, `collectMediaRows()` | Rebuilds the classic flat report from a finished inventory. Nothing is rescanned. Absent from `main`. |
| `content-script.js` | Shadow-root-piercing consent dismissal | New `euAllRoots()` walker so overlay passes reach open shadow roots (Usercentrics renders entirely inside one). Adds Hindi accept/close labels and Google Funding Choices selectors. `main` only queries `document`. |
| `popup/popup.js`, `popup/popup.html` | `defaultsVer: 50` migration | New default recipe: axe-core only. Media, PDF/Office, visual-state checks, overlay dismissal and audit-both become opt-in. `main` defaults all of them ON. **Product decision, not a bug** — see Open decisions. |
| `lib/visual-checks.js` | WCAG 1.4.1 nav-chrome exclusion | Nav / header / footer / breadcrumb / pagination links are excluded from link-in-text-block analysis, plus two guards that skip the check entirely when no CSS is readable (cross-origin stylesheets). Without these, every nav link on every page is flagged. |
| `report/report.js`, `report/inventory.js` | Page status pills + tile roll-up | Clean / Issues / Unreachable per page, with a summary tile row. Distinguishes "completed with 0 violations" from "never reachable". |
| `report/inventory.html` | "Open Classic Report" button | Entry point for `openClassicReport()`. |
| `lib/xlsx-writer.js` | "Issue Screenshots" sheet | Dedicated sheet, one row per violating element with a preview plus URL / Rule ID / Impact / Target / Success Criteria, capped at `MAX_ISSUE_SHOTS = 300`. |

### Only in `main`

| Area | Feature | Status |
| --- | --- | --- |
| `report/report.js`, `report/report.html` | Report-viewer screenshot rendering | **Ported** in `8fe7d80`. Lazy `IntersectionObserver` loading, storage-first resolution with a `GET_SCREENSHOT` fallback, gallery section, Screenshot column in Violations. |
| `background.js` | Element-shot quality: overlay box, `behavior:'instant'`, paint delay, 400×300 minimum context crop, scroll restore | **Ported** in `8fe7d80`, re-based onto page coordinates. |
| `background.js` | Screenshot capture in `scanCurrent()` | **Ported** in `8fe7d80`. Single-page scans previously produced no imagery. |
| `lib/xlsx-writer.js` | "Preview" column inline in the Violations sheet | **Ported** in v0.5.0, alongside the dedicated sheet. |
| `background.js` | `skipScroll` param | **Ported** in v0.5.0, once the viewport override gave it a meaning. |
| `background.js` | `Emulation.setDeviceMetricsOverride` in `captureFullPageScreenshot` | **Concept ported, implementation rewritten** in v0.5.0 — height-only, plus a settle wait, and keeping the page capture main had lost. |

Excel sheets are a strict superset locally: all 21 of main's sheets, plus
"Issue Screenshots".

---

## Defects found in `main` — do not reintroduce

1. **`captureFullPageScreenshot` never captures the page.** The body is
   `let shot = null;` → element shots → `return shot;`. There is no
   `Page.captureScreenshot` call for the page itself, and the only id ever
   minted is `shot-el-*`. So `p.screenshot` is always `null` on `main` and
   full-page screenshots have never worked there, despite the manifest
   claiming otherwise. The local version is intact.

2. **The screenshot gallery is dead code.** `main`'s `report.js` queries
   `screenshots-section` / `screenshots-grid`, but neither id exists in any
   HTML file. `getElementById` returns `null`, the guard fails silently, and
   the gallery never renders. Fixed while porting by adding the markup.

3. **Debug logging left in.** `console.log("Hereeee")`, `console.log("Herre2")`,
   `[SELECTOR]`, `[CAPTURE]`, `[SKIP]`, and a `console.log` inside the injected
   page expression. Stripped during the port.

4. **`.screenshot-missing` is referenced but unstyled** (true on both sides
   before `a62934b`). An unresolvable screenshot drew as a blank grey
   rectangle: the `alt` never surfaces because the 1×1 placeholder `src` loads
   successfully. Fixed in `a62934b`.

Two defects were also fixed on the local side during the port:

- `inventoryPagesToReportPages()` dropped `p.screenshot`, so a classic report
  derived from an inventory crawl always had an empty gallery even with images
  in storage.
- `persistReport()` saved the report object but none of its screenshots, so
  reports survived service-worker eviction while their images did not.

---

## Decisions — settled in v0.5.0

**1. Default recipe — kept axe-only opt-in.** `main` enables media, PDF/Office,
visual checks, overlay dismissal and audit-both by default; `audit both` alone
doubles per-page audit time. The local `README.md` and `CRAWL-PIPELINE.md`
already documented the opt-in defaults, so this tree is self-consistent —
main's docs disagree with main's own code on this point.

**2. Excel screenshot layout — took both.** The inline Preview column is now on
the Violations sheet (main's approach) *and* the dedicated Issue Screenshots
sheet is retained (this tree's), plus previews on Pages. Violations is the sheet
auditors work in, so the preview belongs on the finding's own row; the dedicated
sheet still earns its place by carrying Impact / Success Criteria context and
enforcing the `MAX_ISSUE_SHOTS` cap. `drawingSpecs` already supported N sheets,
so this was mechanical.

Note the same `shotId` is written once per drawing spec rather than shared —
OOXML requires each drawing to own its image parts. Element crops are small and
capped, so the duplication is cheap.

**3. Full-page capture on tall pages — took the idea, not the code.** The layout
viewport is now expanded to the full document height before capture, which fires
every `IntersectionObserver` and is what makes lazy-loaded below-the-fold content
render. Two deliberate departures from main's version:

- **Height only.** main forced width into an 800–1920 clamp, which silently
  crosses responsive breakpoints — the evidence would then show a layout no user
  at that window size sees. Wrong evidence is worse than none.
- **A bounded wait for images to settle** (4 s) after expanding. main expanded
  and captured immediately, which freezes lazy images mid-fetch — the capture
  would show placeholders even though the expansion had triggered the loads.

`deviceScaleFactor` keeps the tab's real DPR for sharpness, dropping to 1 once
the surface exceeds ~8 MP so a 2× scale on a very tall page can't take the
renderer down. Document height is clamped at 20000px.

With the override active, `skipScroll` finally has a meaning and is wired up:
scroll position is pinned at 0 and every element is in view, so `scrollIntoView`
is pointless and would only disturb a page we just settled. The crop maths stays
in **page** coordinates, which is correct either way — main's viewport
coordinates were only correct *because* its override was active.

---

## Known rough edges

- **`manifest.json` description is ~6300 characters.** Chrome's documented limit
  is 132, enforced when publishing to the Web Store. This predates v0.5.0 (the
  previous local description was 4686 chars, main's 4173) and loading unpacked
  tolerates it, but it must be cut to a real one-liner before any Web Store
  submission, with the changelog moved here or to the README.
- **The classic-report Excel has no previews.** `buildReportXlsx` builds its
  Violations sheet from `report.issueRows` via `objRowsToSheet` and embeds no
  images; only the inventory workbook carries them. Reprojecting a crawl via
  "Open Classic Report" and exporting from there therefore loses the previews.
- **`package.json` still says `0.1.0`.** It has been out of step with the
  manifest for a long time; nothing reads it, but it is misleading.

---

## Remaining work

1. **Verify the capture path in Chrome.** This is the only real gap.
   `test/viewer-harness/` covers the report viewer with 23 assertions, but
   everything behind `chrome.debugger` — the viewport override, the settle wait,
   the overlay box, the element crops, scroll restore, `scanCurrent` capture, and
   the new Violations previews landing in the workbook — is unexercised. Load
   unpacked, tick **Screenshots**, scan a long lazy-loading page.
2. Merge into `main` and tag **v0.5.0**. Keep `local-0.4.9` as the record of what
   the out-of-git tree contained.
