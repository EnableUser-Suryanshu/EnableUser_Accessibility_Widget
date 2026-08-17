// Merge Claude verdicts back into one findings file.
// Usage: node tools/ai-review/merge.mjs <casedir> <out-findings.json> [confidenceThreshold]
import { readFileSync, writeFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

const [dir, outPath, thresholdArg] = process.argv.slice(2);
if (!dir || !outPath) {
  console.error("usage: node tools/ai-review/merge.mjs <casedir> <out-findings.json> [confidenceThreshold]");
  process.exit(1);
}
const THRESHOLD = Number.isFinite(parseFloat(thresholdArg)) ? parseFloat(thresholdArg) : 0.7;
const indexed = JSON.parse(readFileSync(join(dir, "INDEX.json"), "utf8"));

const confirmed = [], dismissed = [], reviewQueue = [], missing = [];
for (const c of indexed.cases) {
  let v = null;
  try { v = JSON.parse(readFileSync(join(dir, `${c.caseId}.verdict.json`), "utf8")); }
  catch { missing.push(c.caseId); continue; }
  const conf = Number(v.confidence) || 0;
  const entry = { ...c, verdict: v.verdict, confidence: conf, reason: v.reason || "", fixSuggestion: v.fixSuggestion || "" };
  if (v.verdict === "violation" && conf >= THRESHOLD) {
    confirmed.push({
      id: `ai-confirmed-${c.ruleId}`,
      impact: "serious",
      tags: ["EU-ai", "review-resolved"],
      description: `AI-confirmed (${Math.round(conf * 100)}% confidence): ${v.reason}`,
      help: v.fixSuggestion || "",
      pageUrl: c.pageUrl, caseId: c.caseId
    });
  } else if (v.verdict === "pass" && conf >= THRESHOLD) {
    dismissed.push(entry);
  } else {
    reviewQueue.push(entry);   // needs-human, or any verdict under threshold
  }
}
const out = {
  testId: indexed.testId,
  threshold: THRESHOLD,
  totals: { cases: indexed.cases.length, confirmed: confirmed.length, dismissed: dismissed.length, reviewQueue: reviewQueue.length, missingVerdicts: missing.length },
  confirmed, dismissed, reviewQueue, missingVerdicts: missing
};
writeFileSync(outPath, JSON.stringify(out, null, 2));
console.log(`merged: ${confirmed.length} confirmed, ${dismissed.length} dismissed, ${reviewQueue.length} for human review, ${missing.length} verdict(s) missing → ${outPath}`);
if (missing.length) process.exit(2);
