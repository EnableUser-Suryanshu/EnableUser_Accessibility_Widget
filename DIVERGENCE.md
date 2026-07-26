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
| `lib/xlsx-writer.js` | "Preview" column inline in the Violations sheet | **Not ported.** Equivalent capability, different layout — see Open decisions. |
| `background.js` | `skipScroll` param | **Deliberately not ported.** Only meaningful alongside `Emulation.setDeviceMetricsOverride`, which this tree does not use. |
| `background.js` | `Emulation.setDeviceMetricsOverride` in `captureFullPageScreenshot` | **Not ported.** Arrived together with the regression below. |

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

## Open decisions

These are judgement calls, not defects. Nothing is blocked on them.

**1. Default recipe — keep axe-only opt-in, or main's everything-on?**
The local tree defaults to axe-core only for scan speed; `main` enables media,
PDF/Office, visual checks, overlay dismissal and audit-both by default for
coverage. Recommend keeping the local default: `audit both` alone doubles
per-page audit time. The local `README.md` and `CRAWL-PIPELINE.md` already
document the opt-in defaults, so the tree is self-consistent — main's docs
disagree with main's own code on this point.

**2. Excel screenshot layout — dedicated sheet, inline column, or both?**
Local ships an "Issue Screenshots" sheet; `main` puts a "Preview" column
directly in the Violations sheet. Both embed previews in the Pages sheet. The
dedicated sheet carries more context per row and caps at 300 images.
Recommend keeping it, and optionally adding main's inline Preview column as
well — the two are additive, not conflicting.

**3. Full-page capture on very tall pages.** `main`'s device-metrics override
expands the layout viewport to the whole document before capturing, which is
a genuinely better approach for tall or lazy-loading pages than relying on
`captureBeyondViewport` alone. The idea is worth taking even though main's
implementation lost the capture call. Optional enhancement, not a fix.

---

## Path to one codebase

1. `port-viewer-screenshots` is the unified tree. Verify it in Chrome —
   `test/viewer-harness/` covers the report viewer; the capture path
   (`chrome.debugger`) still needs a manual run.
2. Settle the open decisions above.
3. Rewrite the `manifest.json` description to cover both feature sets, and
   bump to **0.5.0** — the version carries two independent v0.4.9s plus fixes,
   so reusing 0.4.9 would be a third meaning for the same number.
4. Merge into `main` and tag. Keep `local-0.4.9` as the record of what the
   out-of-git tree contained.
