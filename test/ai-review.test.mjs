// Round-trips a synthetic workflow AI evidence bundle through prepare → fake
// verdicts → merge, pinning the pipeline contract: every review node becomes
// a case, evidence excerpts locate the flagged node, and merge buckets by
// verdict + confidence threshold (under-threshold NEVER confirms).
// Run:  node test/ai-review.test.mjs
import { execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, rmSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const tmp = join(root, "test", ".tmp-ai-review");
rmSync(tmp, { recursive: true, force: true });
mkdirSync(tmp, { recursive: true });

let failures = 0;
const check = (name, cond) => {
  if (cond) console.log(`  ok  ${name}`);
  else { console.error(`FAIL  ${name}`); failures++; }
};

const bundle = {
  generator: "test", testId: "wf-test", profile: "wcag21aa",
  pages: [], steps: [], counts: {},
  reviewItems: [
    { pageUrl: "https://x.com/a", step: "s1", ruleId: "image-alt-quality", description: "alt text meaningfulness",
      nodes: [{ html: '<img src="hero.png" alt="image">', target: ["#hero"], failureSummary: "verify alt conveys meaning" }] },
    { pageUrl: "https://x.com/a", step: "s1", ruleId: "heading-order", description: "heading semantics",
      nodes: [{ html: "<h4>Contact</h4>", target: ["h4"], failureSummary: "" }] }
  ],
  evidence: [{ stepId: "s1", url: "https://x.com/a", dom: `<html><body><main><p>intro</p><img src="hero.png" alt="image"><h4>Contact</h4></main></body></html>`, css: "" }]
};
const bundlePath = join(tmp, "bundle.json");
writeFileSync(bundlePath, JSON.stringify(bundle));

const caseDir = join(tmp, "cases");
execFileSync("node", [join(root, "tools/ai-review/prepare.mjs"), bundlePath, caseDir]);
const index = JSON.parse(readFileSync(join(caseDir, "INDEX.json"), "utf8"));
check("one case per review node", index.cases.length === 2);
check("evidence resolved by step", index.cases.every(c => c.hasEvidence));
const case1 = readFileSync(join(caseDir, "case-001.md"), "utf8");
check("prompt embeds flagged node", case1.includes('alt="image"'));
check("prompt excerpt located the node in the snapshot", case1.includes("bytes "));
check("prompt demands strict verdict JSON", case1.includes('"verdict":"violation|pass|needs-human"'));

// Fake verdicts: one confident violation, one under-threshold violation.
writeFileSync(join(caseDir, "case-001.verdict.json"), JSON.stringify(
  { caseId: "case-001", verdict: "violation", confidence: 0.9, reason: "alt is generic", fixSuggestion: "describe the image" }));
writeFileSync(join(caseDir, "case-002.verdict.json"), JSON.stringify(
  { caseId: "case-002", verdict: "violation", confidence: 0.4, reason: "unsure", fixSuggestion: "" }));

const outPath = join(tmp, "findings.json");
execFileSync("node", [join(root, "tools/ai-review/merge.mjs"), caseDir, outPath]);
const out = JSON.parse(readFileSync(outPath, "utf8"));
check("confident violation confirmed", out.confirmed.length === 1 && out.confirmed[0].caseId === "case-001");
check("confirmed carries EU-ai tag", out.confirmed[0].tags.includes("EU-ai"));
check("under-threshold verdict goes to human queue", out.reviewQueue.length === 1 && out.reviewQueue[0].caseId === "case-002");
check("nothing dismissed", out.dismissed.length === 0);
check("totals consistent", out.totals.cases === 2 && out.totals.missingVerdicts === 0);

rmSync(tmp, { recursive: true, force: true });
if (failures) { console.error(`\n${failures} failure(s)`); process.exit(1); }
console.log("\nai-review pipeline contract holds");
