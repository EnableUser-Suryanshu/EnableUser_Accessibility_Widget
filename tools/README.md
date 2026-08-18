# tools/ — offline processing for reports and evidence bundles

Node scripts that run OUTSIDE the extension, on the artifacts it exports.
Nothing here talks to a server; everything stays on the machine.

## ai-review/ — local Claude judging of workflow evidence

The vendors' server-AI layer done locally: split a workflow AI evidence
bundle into per-case prompts (with DOM excerpts + step viewport PNGs),
judge them with Claude, merge the strict-JSON verdicts back into a findings
file. Full pipeline contract in [ai-review/README.md](ai-review/README.md).

```bash
node tools/ai-review/prepare.mjs <bundle.json> <casedir>
# … Claude writes <case>.verdict.json next to each prompt …
node tools/ai-review/merge.mjs <casedir> findings.json
```

## regression-diff.mjs — retest comparison by issue identity

Compare two report JSON exports (the report page's **Download JSON**
button) and answer the retest question: what got **fixed**, what is
**still present**, what is **new** — per rule and per page.

```bash
node tools/regression-diff.mjs baseline.json retest.json [outdir]
# → outdir/regression-diff.md   (human summary: counts, per-rule/per-page tables, issue lists)
# → outdir/regression-diff.json (machine findings: fixed[] / stillPresent[] / new[] with hashes)
```

Identity is `hash(node html + target selector + rule id + normalized page
URL)` — the SAME recipe the extension's live dedup layers use
(`lib/workflow.js issueHash`), so the diff agrees with what the session and
merge views call "the same issue". Consequences to know:

- Rows listed under several WCAG criteria collapse to one issue per side
  (issueRows carry one row per node×criterion).
- A defect re-rendered with different markup reads as **fixed + new** —
  the honest reading: the originally filed finding no longer reproduces.
- Query strings / fragments are stripped from the page URL before hashing
  (tracking params must not fake regressions).

The diff logic is a pure export (`diffReports`) pinned by
`test/regression-diff.test.mjs`.

## Related in-extension features (not scripts)

- **MERGE_ENGAGEMENT** — crawl + workflow fusion into one source-tagged
  union report (Coverage sheet + "Seen By" column). Pure merge logic in
  `lib/engagement-merge.js`, pinned by `test/engagement-merge.test.mjs`;
  offered in the DevTools panel after a workflow stop.
- **Download JSON** — the report page button that produces the full
  persisted report payload this folder's scripts consume.
