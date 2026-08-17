// Split a workflow AI evidence bundle into per-case Claude prompts.
// Usage: node tools/ai-review/prepare.mjs <bundle.json> <outdir>
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const [bundlePath, outdir] = process.argv.slice(2);
if (!bundlePath || !outdir) {
  console.error("usage: node tools/ai-review/prepare.mjs <bundle.json> <outdir>");
  process.exit(1);
}
const bundle = JSON.parse(readFileSync(bundlePath, "utf8"));
mkdirSync(outdir, { recursive: true });

// Evidence lookup by step; fall back to any evidence for the same URL.
const evByStep = new Map((bundle.evidence || []).map(e => [e.stepId, e]));
const evByUrl = new Map((bundle.evidence || []).map(e => [String(e.url || "").split(/[?#]/)[0], e]));

// A prompt only gets the slice of DOM around the flagged node (the model
// doesn't need 1.5 MB of page to judge one image's alt text) — but the slice
// boundaries are recorded so the judgment is auditable.
function domExcerpt(dom, nodeHtml, radius = 4000) {
  if (!dom) return { excerpt: "", note: "no evidence snapshot for this step" };
  const probe = String(nodeHtml || "").slice(0, 160);
  const at = probe ? dom.indexOf(probe) : -1;
  if (at === -1) return { excerpt: dom.slice(0, radius * 2), note: "node not located in snapshot — showing document head region" };
  const start = Math.max(0, at - radius);
  return { excerpt: dom.slice(start, at + probe.length + radius), note: `bytes ${start}–${at + probe.length + radius} of snapshot` };
}

const index = [];
let n = 0;
for (const item of bundle.reviewItems || []) {
  for (const node of item.nodes || []) {
    const caseId = `case-${String(++n).padStart(3, "0")}`;
    const ev = evByStep.get(item.step) || evByUrl.get(String(item.pageUrl || "").split(/[?#]/)[0]);
    const { excerpt, note } = domExcerpt(ev?.dom, node.html);
    const md = `# ${caseId} — ${item.ruleId}

**Page:** ${item.pageUrl}
**Workflow step:** ${item.step}
**Rule:** ${item.ruleId} — ${item.description}
**Engine said:** needs review. ${node.failureSummary || item.help || ""}

## Flagged element
\`\`\`html
${node.html || "(none)"}
\`\`\`
Selector: \`${JSON.stringify(node.target || [])}\`

## Evidence (rendered DOM excerpt — ${note})
\`\`\`html
${excerpt}
\`\`\`

## Your task
Judge this single finding. Reply by writing \`${caseId}.verdict.json\` next to
this file containing EXACTLY:
\`\`\`json
{"caseId":"${caseId}","verdict":"violation|pass|needs-human","confidence":0.0,"reason":"one sentence grounded in the evidence above","fixSuggestion":"concrete fix, or empty string"}
\`\`\`
Rules: judge only from the evidence shown; if the evidence is insufficient,
verdict is "needs-human" — never guess. Confidence reflects the evidence,
not the prior.
`;
    writeFileSync(join(outdir, `${caseId}.md`), md);
    index.push({ caseId, ruleId: item.ruleId, pageUrl: item.pageUrl, step: item.step, hasEvidence: !!ev });
  }
}
writeFileSync(join(outdir, "INDEX.json"), JSON.stringify({ testId: bundle.testId, generated: bundle.generator, cases: index }, null, 2));
console.log(`${index.length} case prompt(s) written to ${outdir} (${index.filter(c => c.hasEvidence).length} with evidence snapshots)`);
