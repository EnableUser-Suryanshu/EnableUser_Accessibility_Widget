// Unit tests for tools/regression-diff.mjs — the pure diff: identity-hash
// matching across two report exports, fixed/still/new bucketing, per-rule
// and per-page tallies, and criterion-row dedup (issueRows carry one row per
// node×criterion; hash-identical rows are ONE issue).
import { diffReports, rowHash } from "../tools/regression-diff.mjs";

let failures = 0;
function check(name, ok, detail = "") {
  console.log(`${ok ? "PASS " : "FAIL "} ${name}${detail ? " — " + detail : ""}`);
  if (!ok) failures++;
}

const row = (url, ruleId, sel, html, extra = {}) => ({
  url, rule_id: ruleId, selector: sel, target_array: [sel], html_snippet: html,
  impact: "serious", wcag_criterion: "1.1.1", failure_summary: "", ...extra
});

const oldRows = [
  row("https://x.test/a", "image-alt", "#i1", "<img src=1>"),
  row("https://x.test/a", "image-alt", "#i2", "<img src=2>"),
  row("https://x.test/b", "label", "#q", "<input id=q>"),
  // Same node listed under a second criterion — one issue, not two.
  row("https://x.test/a", "image-alt", "#i1", "<img src=1>", { wcag_criterion: "4.1.2" })
];
const newRows = [
  row("https://x.test/a?v=2", "image-alt", "#i1", "<img src=1>"),  // still present (URL normalizes)
  row("https://x.test/b", "label", "#new", "<input id=new>"),      // new
  row("https://x.test/c", "color-contrast", "#p", "<p id=p>")       // new
];

const d = diffReports(oldRows, newRows);
check("criterion-duplicate rows collapse to one issue", d.counts.old === 3, `old=${d.counts.old}`);
check("still-present matched through URL normalization", d.counts.stillPresent === 1 && d.stillPresent[0].selector === "#i1");
check("fixed = old issues absent from retest", d.counts.fixed === 2, d.fixed.map(r => r.selector).join(","));
check("new = retest issues absent from baseline", d.counts.newIssues === 2, d.new.map(r => r.selector).join(","));
check("per-rule tally", d.perRule["image-alt"].fixed === 1 && d.perRule["image-alt"].stillPresent === 1 && d.perRule["label"].fixed === 1 && d.perRule["label"].new === 1, JSON.stringify(d.perRule));
check("per-page tally on normalized URLs", d.perPage["https://x.test/a"].stillPresent === 1 && d.perPage["https://x.test/c"].new === 1, JSON.stringify(d.perPage));

// Changed markup = fixed + new (the honest reading: the filed finding no
// longer reproduces byte-identically).
const d2 = diffReports(
  [row("https://x.test/a", "image-alt", "#i1", "<img src=1>")],
  [row("https://x.test/a", "image-alt", "#i1", "<img src=1 class=updated>")]
);
check("changed markup reads as fixed+new", d2.counts.fixed === 1 && d2.counts.newIssues === 1 && d2.counts.stillPresent === 0);

// Hash falls back to selector when target_array is missing (older exports).
const legacy = { url: "https://x.test/a", rule_id: "r", selector: "#s", html_snippet: "<x>" };
const modern = { url: "https://x.test/a", rule_id: "r", target_array: ["#s"], selector: "#s", html_snippet: "<x>" };
check("selector fallback hashes identically to target_array", rowHash(legacy) === rowHash(modern));

check("empty diff behaves", (() => { const e = diffReports([], []); return e.counts.fixed === 0 && e.counts.newIssues === 0 && e.counts.stillPresent === 0; })());

if (failures) { console.error(`\n${failures} check(s) failed`); process.exit(1); }
console.log("\nall checks passed");
