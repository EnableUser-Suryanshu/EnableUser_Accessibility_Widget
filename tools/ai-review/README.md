# AI review — local Claude processing of workflow evidence bundles

The role axe DevTools and the BrowserStack toolkit fill with **server-side AI**
(Deque POSTs a screenshot + DOM to `/api/axe-devtools-pro/advanced-rules`;
BrowserStack streams `advanced`/`ai` rules over Socket.IO to
`a11y-engine.browserstack.com`), we fill **locally with Claude**. Nothing
leaves the machine except what you choose to send to the model.

The judgments in scope are exactly the vendors' AI-rule territory, which is
also the human-judgment column of our Manual Test Checklist: alt-text
meaningfulness (S-01), heading semantics (S-06/S-07), text-over-image
contrast (C-13), and triage of every `incomplete` (needs-review) finding the
engines could not decide.

## The pipeline

1. **Record** a workflow session (popup or DevTools panel). On Stop, the
   extension downloads `enableuser-workflow-ai-bundle-<testId>.json`
   alongside the report: session timeline + the needs-review findings +
   per-step DOM/CSS snapshots (capped: 40 snapshots, 1.5 MB DOM / 300 KB CSS
   each).
2. **Prepare**: `node tools/ai-review/prepare.mjs <bundle.json> <outdir>`
   splits the bundle into one self-contained markdown prompt per review item,
   each embedding the finding, its node HTML, and the relevant evidence
   excerpt, plus `INDEX.json` listing every case.
3. **Judge with Claude**: run the prompts through Claude (Claude Code over
   the outdir works: "read each case-*.md in this folder and write the
   verdict JSON it asks for next to it"). Each prompt demands a strict JSON
   verdict: `{"caseId", "verdict": "violation"|"pass"|"needs-human",
   "confidence": 0-1, "reason", "fixSuggestion"}` written to
   `<case>.verdict.json`.
4. **Merge**: `node tools/ai-review/merge.mjs <outdir> <findings.json>`
   collects the verdicts into one findings file: confirmed items formatted as
   rule objects (`ai-confirmed-*`, tagged `EU-ai`), rejected items listed as
   `dismissed`, low-confidence and needs-human items kept in a review queue.
   Feed it to the report conversation or attach it to the engagement folder.

## Honesty rules (same as the visual-checks suite)

- An AI verdict never silently overrides an engine result — it only settles
  items the engines marked `incomplete`, and every confirmed finding carries
  the model's stated reason and confidence.
- Verdicts under the confidence threshold (default 0.7) stay in the review
  queue no matter what the verdict says.
- The evidence excerpt shown to the model is recorded in the prompt file, so
  every judgment is reproducible and auditable after the fact.

## Client-confidentiality note

Evidence bundles contain full page DOM — for SEBI-regulated client sites
treat them like any other client capture: they live in the engagement folder
under `_Workroom`, never in a public location, and the deliverable wording
stays methodology-neutral (no tool names).
